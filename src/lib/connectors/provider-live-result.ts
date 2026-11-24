import { directOutputFilter } from './provider-direct-output';

export const ASK_OWNER_RESULT = 'ask_owner' as const;
type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
const MAX_BYTES = 20_000;
const transportField = /^(?:logs?|errors?|trace|stack|request|response|metadata|composio_execution_message)$/i;

/** Live Ask data, never the raw execution envelope. Only copy own JSON fields; do
 * not coerce decimals, redact structural keys into collisions, or invent values. */
export function projectProviderLiveResult(data: unknown, credential: string, privateValues: string[]) {
  return projectResult(data, credential, privateValues, false);
}

/** The host supplies decoded rows from a recognized SQL action, not the envelope. */
export function projectProviderSqlRows(rows: readonly unknown[] | undefined, credential: string, privateValues: string[]) {
  return projectResult(rows && { rows }, credential, privateValues, true);
}

function projectResult(data: unknown, credential: string, privateValues: string[], sqlRows: boolean) {
  const filter = directOutputFilter(credential, privateValues);
  let bytes = 0, nodes = 0, truncated = false, withheld = false;
  function reserve(n: number) {
    if (bytes + n > MAX_BYTES) { truncated = true; return false; }
    bytes += n;
    return true;
  }
  function visit(value: unknown, depth: number): Value | undefined {
    if (++nodes > 2048 || depth > 10) { truncated = true; return; }
    if (!value || typeof value !== 'object') {
      if (filter.cell(value, 4000, true) === undefined || (typeof value === 'string' && /\bdata:[^\s,;]*[;,]/i.test(value))) { withheld = true; return; }
      const scalar = value as null | boolean | number | string;
      return reserve(Buffer.byteLength(JSON.stringify(scalar)) + 1) ? scalar : undefined;
    }
    if (!reserve(3)) return;
    if (Array.isArray(value)) {
      const items: Value[] = [];
      for (let i = 0; i < value.length; i++) {
        if (i === 100 || nodes >= 2048 || bytes >= MAX_BYTES) { truncated = true; break; }
        const item = Object.getOwnPropertyDescriptor(value, i);
        if (!item || !('value' in item)) { withheld = true; continue; }
        const projected = visit(item.value, depth + 1);
        if (projected !== undefined) items.push(projected);
      }
      return !items.length && value.length ? undefined : items;
    }
    const fields: Record<string, Value> = Object.create(null);
    const keys = Object.keys(value);
    // Only direct column keys in { rows: [{ … }] }, never nested JSON fields.
    const allowedField = sqlRows && depth === 2 ? filter.sqlColumn : filter.field;
    for (const key of keys) {
      if (nodes >= 2048 || bytes >= MAX_BYTES) { truncated = true; break; }
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !('value' in field) || transportField.test(key) || !allowedField(key)) { withheld = true; continue; }
      if (!reserve(Buffer.byteLength(JSON.stringify(key)) + 2)) break;
      const projected = visit(field.value, depth + 1);
      if (projected !== undefined) fields[key] = projected;
    }
    return !Object.keys(fields).length && keys.length ? undefined : fields;
  }
  const result = data === null ? undefined : visit(data, 0);
  return { result, truncated, withheld };
}