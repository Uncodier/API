import { catalogSafeLabel, resultUnsupported } from './catalog-read-result';
import { reportBinding, reportRequest, reportViewId } from './supabase-report-contract';
import type { Connector } from './types';

const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const publish = 'Ask the database administrator to check the site-specific reporting schema and publish an appropriate aggregate view readable by the existing reporting role. Do not switch accounts or request credentials.';

/** Never search recursively for data, pass a provider wrapper through, or infer success from an empty
 * array. Only the single site/view-bound frame emitted by our SELECT is a report response. */
export function projectSupabaseCatalogResult(data: unknown, connector: Connector, args: Record<string, unknown>, key: string) {
  const { schema } = reportBinding(connector);
  const { view, limit, after } = reportRequest(args);
  if (!key) resultUnsupported();
  let frames: unknown = data;
  if (typeof frames === 'string') {
    if (Buffer.byteLength(frames) > 16_384) resultUnsupported();
    try { frames = JSON.parse(frames); } catch { resultUnsupported(); }
  }
  // Published Composio v20261116_00 / RunReadOnlyQueryResponse: data.result holds
  // the SQL rows. Never recursively unwrap arbitrary data or expose envelope fields.
  if (exact(frames, ['result', 'rows_returned'])) {
    if (frames.rows_returned !== 1) resultUnsupported();
    frames = frames.result;
  } else if (exact(frames, ['result'])) {
    frames = frames.result;
  }
  if (!Array.isArray(frames) || frames.length !== 1) resultUnsupported();
  const frame: unknown = frames[0];
  if (!exact(frame, ['report_schema', 'report_view', 'report_rows']) || frame.report_schema !== schema ||
    frame.report_view !== (view ?? null)) resultUnsupported();
  if (view && frame.report_rows === null) return { status: 'not_available', guidance: publish };
  const rows = frame.report_rows;
  if (!Array.isArray(rows) || rows.length > (view === undefined ? limit + 1 : limit)) resultUnsupported();
  if (view === undefined) {
    if (!rows.every(reportViewId) || rows.some((n, i) => n.includes(key) || n <= (i ? rows[i - 1] : after ?? ''))) resultUnsupported();
    const views = rows.slice(0, limit);
    const more = rows.length > limit;
    return { views, has_more: more, next_after: more ? views[views.length - 1] : null,
      guidance: more ? 'More published reports exist. Pass next_after as after to continue, or read a listed view.' : views.length
        ? 'This was the final page. Read a published report by passing its exact view name.' : after ? 'No more report names on this page.' : publish };
  }
  const samples = rows.map(row => {
    if (!exact(row, ['label', 'value']) || typeof row.value !== 'string' || row.value.length > 32 ||
      /[^\d.\-]/.test(row.value) || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(row.value) || row.value.includes(key)) resultUnsupported();
    const label = catalogSafeLabel(row.label, key);
    if (!label) resultUnsupported();
    return { label, value: row.value };
  });
  return { view, rows: samples, coverage: 'Bounded sample from the published report; not a total or a complete result set.' };
}
