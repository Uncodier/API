import { resultUnsupported } from './catalog-read-result';
import { reportViewId, SUPABASE_CATALOG_SLUG } from './supabase-report-contract';
import type { AnalyticsAuthority } from './supabase-analytics-authorization';
import { TABLE_TOOL } from './supabase-table-policy';

const MAX_ROWS = 100;
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) resultUnsupported();
  return value as Record<string, unknown>;
};
const text = (v: unknown, max = 200) => typeof v === 'string' && v.length <= max && v.trim() &&
  !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v) ? v : '';
const id = (v: unknown) => (typeof v === 'string' || Number.isSafeInteger(v)) && /^[a-z\d-]{1,40}$/i.test(String(v)) ? String(v) : '';

type Report = { title: string; note: string; columns: string[]; rows: string[][]; published?: true; next_after?: string };
const bounded = 'This is a bounded page, not a total or a complete result set.';

/** Never store an arbitrary provider document, diagnostics, nested records, attachment URLs,
 * message bodies, paging tokens or raw envelopes, even in the private destination. */
export function privateReport(tool: string, catalog: boolean, result: unknown, key: string, analytics?: AnalyticsAuthority): Report {
  const env = object(result);
  if (env.successful !== true || !key) resultUnsupported();
  const data = object(env.data);
  function table(title: string, columns: string[], values: unknown, project: (r: Record<string, unknown>) => string[], note = bounded): Report {
    if (!Array.isArray(values)) resultUnsupported();
    const rows = values.slice(0, MAX_ROWS).map(v => {
      const row = project(object(v));
      if (!row.some(Boolean) || row.length !== columns.length) resultUnsupported();
      return row;
    });
    return { title, columns, rows, note: values.length > MAX_ROWS ? `Only the first ${MAX_ROWS} rows are shown. ${note}` : note };
  }
  let report: Report;
  if (analytics) {
    if (!catalog || tool!==SUPABASE_CATALOG_SLUG || !['workspace','platform'].includes(analytics.scope) ||
      data.kind!=='analytics' || typeof data.has_more!=='boolean' || !Array.isArray(data.columns) || !data.columns.length || data.columns.length>5 ||
      !data.columns.every(c=>typeof c==='string' && /^[a-z][a-z0-9_]{0,47}$/.test(c) && !Object.hasOwn(Object.prototype,c)) ||
      new Set(data.columns).size!==data.columns.length || !Array.isArray(data.rows) || data.rows.length>25) resultUnsupported();
    const columns:string[]=data.columns;
    const rows=data.rows.map(r=>{
      if (!Array.isArray(r) || r.length!==columns.length || r.some(v=>v!==null && (typeof v!=='string' || Buffer.byteLength(v)>200 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v)))) resultUnsupported();
      return r.map(v=>v===null ? 'NULL' : v as string);
    });
    const basis:Readonly<Record<string,string>> = {
      paid_sales:'Currently completed sales with zero recorded balance; sale date and face value in major units, not a cash receipt date.',
      tender_awards:'Approved awards at winning quotation values. Dates are award creation timestamps; net and tax amounts are in minor units.',
      approved_orders:'Approved purchase orders, not cash payments. Dates are order creation timestamps; net and tax amounts are in minor units.',
    };
    const semantics = Object.hasOwn(basis,analytics.source) ? basis[analytics.source] : 'Uses the facts and units configured by the source operator.';
    report={title: analytics.scope==='platform' ? 'All-account analytics query' : 'Workspace analytics query',columns,rows,
      note: `Source: ${analytics.source}. ${semantics} ` + (data.has_more ? 'More rows matched than the requested row limit. This is not a complete breakdown.' : 'Results for the requested filters and scope; NULL is not zero.')};
  } else if (catalog && tool === SUPABASE_CATALOG_SLUG) {
    if (data.kind==='analytics') resultUnsupported(); // SQL output always uses its dedicated private authorization.
    if (data.status === 'not_available') {
      report = { title: 'Published report unavailable', columns: [], rows: [], note: 'Ask the project database administrator to verify the published report and its reporting-role permissions. This does not mean there are zero sales or accounts.' };
    } else if (Array.isArray(data.views) && data.views.length <= 25 && data.views.every(reportViewId)) {
      if (data.has_more !== false && !(data.has_more === true && reportViewId(data.next_after) && data.views.at(-1) === data.next_after)) resultUnsupported();
      report = { title: 'Published reports', published: true, columns: ['Report name'], rows: data.views.map(v => [v]),
        note: data.views.length ? 'Open a report to read its published figures privately.' : 'No published reports were returned on this page. Ask the database administrator to verify publication and reporting-role access.',
        ...(data.has_more === true && { next_after: data.next_after as string }) };
    } else if (reportViewId(data.view)) {
      report = table(`Published report: ${data.view}`, ['Label', 'Value'], data.rows, r => {
        if (!text(r.label) || typeof r.value !== 'string' || r.value.length > 32 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(r.value)) resultUnsupported();
        return [text(r.label), r.value];
      });
    } else resultUnsupported();
  } else if (catalog) {
    report = table('Connector results', ['ID', 'Name', 'Title'], data.items, r => [id(r.id), text(r.name), text(r.title)]);
  } else if (tool === TABLE_TOOL) {
    // The reviewed adapter already projected these names with projectTableNames.
    report = table('Database tables', ['Schema', 'Table'], data.tables, r => [text(r.schema, 63), text(r.name, 63)],
      'Provider-discovered non-system tables. Schema discovery can be partial.');
  } else if (tool === 'GMAIL_FETCH_EMAILS') {
    report = table('Email subjects', ['Message ID', 'Subject'], data.messages, r => [id(r.id ?? r.messageId), text(r.subject)]);
  } else if (tool === 'HUBSPOT_LIST_CONTACTS') {
    report = table('Contacts', ['Contact ID', 'First name', 'Last name'], data.results ?? data.contacts, r => {
      const p = r.properties == null ? {} : object(r.properties);
      return [id(r.id), text(p.firstname), text(p.lastname)];
    });
  } else resultUnsupported();
  const json = JSON.stringify(report);
  if (Buffer.byteLength(json) > 48_000 || json.includes(key)) resultUnsupported();
  return report;
}
