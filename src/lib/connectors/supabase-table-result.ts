import { invalidProviderResponse } from './composio-transport';

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (): never => invalidProviderResponse(true);
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 63 || /[\u0000-\u001f\u007f]/.test(value)
    || /^(?:sbp_|sb_secret_|Bearer\s)/i.test(value)) return invalid();
  return value;
}

/** Composio documents an opaque data object, not a stable nested table-result schema.
 * Only consume explicit table collections; never traverse arbitrary rows, error details,
 * SQL output, or stringify unknown data. Fail closed on unrecognized shapes. */
export function projectTableNames(data: Record<string, unknown>) {
  const tables: { schema: string; name: string }[] = [];
  const add = (entry: unknown, group?: string) => {
    const schema = identifier(isObject(entry) ? entry.table_schema ?? entry.schema ?? group : group);
    const name = identifier(isObject(entry) ? entry.table_name ?? entry.name : entry);
    if ((group !== undefined && group !== schema) || /^(?:pg_|information_schema$|pgbouncer$)/.test(schema)) invalid();
    if (isObject(entry) && (entry.table_type ?? entry.type) !== undefined
      && !['table', 'base table', 'partitioned table', 'foreign table'].includes(String(entry.table_type ?? entry.type).toLowerCase())) invalid();
    tables.push({ schema, name });
    if (tables.length > 3000) invalid();
  };
  const source = data.tables;
  if (source == null && Array.isArray(data.schemas)) {
    for (const group of data.schemas) {
      if (!isObject(group) || !Array.isArray(group.tables)) return invalid();
      const schema = identifier(group.schema_name);
      for (const entry of group.tables) {
        if (!isObject(entry) || entry.schema_name !== schema) return invalid();
        add({ schema, table_name: entry.table_name, table_type: entry.table_type }, schema);
      }
    }
  } else if (Array.isArray(source)) source.forEach(entry => add(entry));
  else if (isObject(source)) {
    for (const [schema, entries] of Object.entries(source)) {
      if (!Array.isArray(entries)) return invalid();
      entries.forEach(entry => add(entry, schema));
    }
  } else return invalid();
  // Never relay raw per-schema failures (may contain SQL, URLs or credentials).
  const hasDetails = (v: unknown) => !!v && (!isObject(v) || Object.keys(v).length > 0) && (!Array.isArray(v) || v.length > 0);
  const queryErrors = isObject(data.query_metadata) ? data.query_metadata.errors : undefined;
  const partial = [queryErrors, data.errors, data.schema_errors, data.warnings, data.next_cursor, data.partial, data.truncated].some(hasDetails);
  return { tables, coverage: partial ? 'Partial: the provider reported incomplete schema discovery.' : 'Provider-discovered non-system tables; schema discovery can be partial.' };
}
