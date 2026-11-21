import type { AnalyticsColumnType } from './supabase-select-types';
const types: Record<AnalyticsColumnType, readonly string[]> = {
  integer: ['int2','int4','int8'], numeric: ['numeric'], date: ['date'], timestamptz: ['timestamptz'],
  boolean: ['bool'], uuid: ['uuid'], text: ['text'],
};
const name = (v: string) => v.length <= 63 && /^[a-z][a-z0-9_]*$/.test(v) && !/[^a-z0-9_]/.test(v);

/** Called only with server policies. No new grants: if the management role cannot already read
 * all relevant rows of these actual typed base relations, fail attestation instead of reporting zero. */
export function baseGuard(schema: string, table: string, columns: Readonly<Record<string, AnalyticsColumnType>>): string {
  const fields = Object.entries(columns);
  if (!name(schema) || !name(table) || !fields.length || !fields.every(([c,t]) => name(c) && Object.hasOwn(types,t))) throw new Error('Invalid server analytics policy');
  const relation = `"${schema}"."${table}"`;
  const attrs = fields.map(([c,t]) => `('${c}', ARRAY[${types[t].map(db=>`'pg_catalog.${db}'::pg_catalog.regtype`).join(',')}])`).join(',');
  // public may be owned by the PostgreSQL 15+ pg_database_owner role. Actual tables must
  // still be postgres-owned; external facts live in a dedicated postgres-owned namespace.
  const namespace = schema === 'public' ? `n.nspowner IN (o.oid, 'pg_database_owner'::pg_catalog.regrole)` : 'n.nspowner = o.oid';
  return `EXISTS (SELECT FROM pg_catalog.pg_class r JOIN pg_catalog.pg_namespace n ON r.relnamespace = n.oid JOIN pg_catalog.pg_roles o ON o.oid = r.relowner AND ${namespace}
    WHERE r.oid = '${relation}'::pg_catalog.regclass AND o.rolname = 'postgres' AND r.relkind = 'r' AND NOT r.relhassubclass AND NOT pg_catalog.row_security_active(r.oid)
    AND NOT EXISTS (SELECT FROM (VALUES ${attrs}) AS spec(col,kinds) WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_attribute a WHERE a.attrelid=r.oid AND a.attnum>0
      AND NOT a.attisdropped AND a.attgenerated='' AND a.attname=spec.col AND a.atttypid=ANY(spec.kinds) AND pg_catalog.has_column_privilege(r.oid,a.attnum,'SELECT'))))`;
}
