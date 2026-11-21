import { ConnectorError } from './types';
import type { PublishedList } from './catalog-read-published';
import { MAX_CATALOG_ROWS, type catalogListOutput } from './catalog-read-schema';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function resultUnsupported(): never {
  throw new ConnectorError('CONNECTOR_RESULT_UNSUPPORTED', 'The provider was called but its result could not be safely projected. Inspect the result in the provider.', 502);
}
const unsafeText = /(?:[\u0000-\u001f\u007f]|:\/\/|\b(?:Bearer|Basic)\s|\b(?:api.?key|secret|token|password|credential|authorization)\b|(?:sk-|gh[pousr]_|xox[baprs]-|sbp_|sb_secret_|AIza|AKIA)|[\w+/=-]{24,}|-----BEGIN|\w+\.\w+\.\w{12,})/i;
const label = new RegExp("^[\\p{L}\\p{N}][\\p{L}\\p{N} .,'’()&-]*$", 'u');
export function catalogSafeLabel(value: unknown, key: string) {
  // Business labels only; no blobs, free-form diagnostics, URLs, encoded credentials or markup.
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && !value.includes(key) && !unsafeText.test(value)
    && label.test(value) ? value : undefined;
}

export function projectCatalogList(data: unknown, shape: ReturnType<typeof catalogListOutput>, limit: number, key: string) {
  if (!record(data)) resultUnsupported();
  if (!Object.hasOwn(data, shape.collection) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_ROWS) resultUnsupported();
  const rows = data[shape.collection];
  if (!Array.isArray(rows) || rows.length < shape.min || rows.length > Math.min(limit, shape.max)) resultUnsupported();
  return { items: rows.map(row => {
    if (!record(row) || shape.required.some(k => !Object.hasOwn(row, k))) resultUnsupported();
    for (const [k, type] of Object.entries(shape.fields)) {
      if (Object.hasOwn(row, k) && (type === 'integer' ? !Number.isSafeInteger(row[k]) : typeof row[k] !== 'string')) resultUnsupported();
    }
    const item: Record<string, string | number> = {};
    // Do not reflect arbitrary identifiers, keys, nested provider data, logs or pagination tokens.
    if (shape.fields.id === 'integer' && typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id >= 0) item.id = row.id;
    if (shape.fields.id === 'string' && typeof row.id === 'string' && /^\d{1,18}$/.test(row.id) && !row.id.includes(key)) item.id = row.id;
    for (const field of ['name', 'title'] as const) {
      if (shape.fields[field] !== 'string') continue;
      const label = catalogSafeLabel(row[field], key);
      if (label !== undefined) item[field] = label;
    }
    if (!Object.keys(item).length) resultUnsupported();
    return item;
  }) };
}

const calendarRoles = ['freeBusyReader', 'reader', 'writerWithoutPrivateAccess', 'writer', 'owner'];
const boundedText = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Consume exactly the public wrapper's data.results or data.calendars. There is no
 * recursive key search, arbitrary JSON decoding, implicit empty page or result passthrough. */
export function projectPublishedList(data: unknown, profile: PublishedList, limit: number, key: string) {
  if (!record(data) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_ROWS) resultUnsupported();
  const collection = profile.kind === 'hubspot' ? 'results' : 'calendars';
  const rows = data[collection];
  if (!Object.hasOwn(data, collection) || !Array.isArray(rows) || rows.length > limit) resultUnsupported();
  return { items: rows.map(row => {
    if (!record(row)) resultUnsupported();
    if (profile.kind === 'hubspot') {
      if (typeof row.id !== 'string' || !/^\d{1,18}$/.test(row.id) || row.id.includes(key) || !record(row.properties) ||
        !boundedText(row.createdAt, 64) || !boundedText(row.updatedAt, 64) ||
        (profile.resource === 'companies' || row.archived !== undefined) && row.archived !== false) resultUnsupported();
      const name = catalogSafeLabel(row.properties[profile.nameField], key);
      return { id: row.id, ...(name !== undefined && { name }) };
    }
    // A calendar ID is often an email. A display name/summary is frequently personal
    // data as well. None of the original strings identify an account in our result.
    if (!boundedText(row.id, 1024) || !boundedText(row.etag, 1024) || row.kind !== 'calendar#calendarListEntry' ||
      (row.primary !== undefined && typeof row.primary !== 'boolean') ||
      [row.hidden, row.deleted].some(v => v !== undefined && v !== false)) resultUnsupported();
    const role = row.accessRole;
    if (role !== undefined && (typeof role !== 'string' || !calendarRoles.includes(role))) resultUnsupported();
    return { name: `${row.primary ? 'Primary calendar' : 'Calendar'}${role ? ` (${role})` : ''}` };
  }) };
}
