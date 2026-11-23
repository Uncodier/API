import { directOutputFilter, type DirectReport } from './provider-direct-output';

const beta = 'SUPABASE_BETA_RUN_SQL_QUERY';
const readOnly = 'SUPABASE_RUN_READ_ONLY_QUERY';
type SqlAction = typeof beta | typeof readOnly;

export function supabaseSqlAction(toolkit: string, slug: string): SqlAction | undefined {
  if (toolkit === 'supabase' && (slug === beta || slug === readOnly)) return slug;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function field(value: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d?.enumerable && 'value' in d ? d.value : undefined;
}

/** Only inspect the direct SELECT result wrapper. Do not search nested data or infer
 * rows from rows_affected alone (which can also describe a write). */
export function supabaseSqlRows(action: SqlAction, data: unknown): readonly unknown[] | undefined {
  if (!object(data)) return;
  const rows = field(data, 'result');
  if (!Array.isArray(rows) || !rows.every(object)) return;
  if (action === beta) {
    if (field(data, 'command') !== 'SELECT' || field(data, 'rows_affected') !== rows.length) return;
  } else if (Object.keys(data).some(key => key !== 'result' && key !== 'rows_returned') ||
             (Object.hasOwn(data, 'rows_returned') && field(data, 'rows_returned') !== rows.length)) return;
  return rows;
}

/** Format SQL rows for the existing owner-only receipt. Redact before storage;
 * never copy the query, provider envelope, or diagnostics into this report. */
export function supabaseSqlReport(rows: readonly unknown[] | undefined, credential: string, privateValues: string[] = []): DirectReport {
  const title = 'Supabase query result';
  const status = (note: string): DirectReport => ({ title, note, columns: ['Result'], rows: [] });
  const unmapped = 'The provider confirmed execution, but Makinari could not display the SQL response as a table. This does not confirm an empty result.';
  if (!rows) return status(unmapped);
  if (!rows.length) return status('The provider returned no rows for this query. This is not a project-wide total.');
  const first = field(rows, '0');
  if (!object(first)) return status(unmapped);

  const filter = directOutputFilter(credential, privateValues);
  const keys = Object.keys(first);
  const visible = keys.filter(filter.field);
  const columns = visible.slice(0, 5); // Existing private report DTO permits at most five columns.
  if (!columns.length) return status('Makinari did not display any columns from the SQL response. This does not confirm an empty result.');
  const preview: string[][] = [];
  let withheld = visible.length < keys.length, bytes = 0;
  for (let i = 0; i < Math.min(rows.length, 100); i++) {
    const row = field(rows, String(i));
    if (!object(row) || Object.keys(row).length !== keys.length || !columns.every(key => Object.hasOwn(row, key))) return status(unmapped);
    const values = columns.map(key => {
      const cell = filter.cell(field(row, key));
      if (cell !== undefined) return cell;
      withheld = true;
      return '[withheld]';
    });
    bytes += Buffer.byteLength(JSON.stringify(values)) + columns.length + 4;
    if (bytes > 40_000) break;
    preview.push(values);
  }
  return { title, columns, rows: preview,
    note: 'Rows returned for this query, not a project-wide total. NULL is not zero.' +
      (withheld ? ' Sensitive or unsupported fields were omitted.' : '') +
      (preview.length < rows.length || columns.length < visible.length ? ' This private preview is truncated.' : '') };
}