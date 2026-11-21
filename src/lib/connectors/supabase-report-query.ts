import { REPORT_NAME_SHAPE, REPORT_NAME_EXCLUSIONS, reportBinding, reportRequest } from './supabase-report-contract';
import type { Connector } from './types';

// A schema name alone is not publication: tenants must not be able to publish a view of their own
// into somebody else's namespace. Trust only the project administrator (postgres) as publisher.
const published = `SELECT c.oid, c.relname
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = n.nspowner AND owner.oid = c.relowner
  JOIN pg_catalog.pg_attribute AS l ON l.attrelid = c.oid AND l.attnum > 0 AND NOT l.attisdropped
    AND l.attname = 'label' AND l.atttypid = 'pg_catalog.text'::pg_catalog.regtype
  JOIN pg_catalog.pg_attribute AS v ON v.attrelid = c.oid AND v.attnum > 0 AND NOT v.attisdropped
    AND v.attname = 'value' AND v.atttypid IN ('pg_catalog.numeric'::pg_catalog.regtype, 'pg_catalog.int2'::pg_catalog.regtype,
      'pg_catalog.int4'::pg_catalog.regtype, 'pg_catalog.int8'::pg_catalog.regtype)
  WHERE CURRENT_USER = 'supabase_read_only_user' AND owner.rolname = 'postgres' AND c.relkind = 'v'
    AND n.nspname = $1::pg_catalog.name AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
    AND pg_catalog.has_table_privilege(c.oid, 'SELECT')`;

// SQL parameters cannot stand for relation identifiers. The only two quoted identifiers come from
// reportBinding's canonical UUID and reportRequest's short ASCII report ID; never accept raw fragments.
export function reportArguments(connector: Connector, args: Record<string, unknown>) {
  const { ref, schema } = reportBinding(connector);
  const { view, limit, after } = reportRequest(args);
  if (view === undefined) {
    const query = `SELECT $1::pg_catalog.text AS report_schema, NULL::pg_catalog.text AS report_view,
  COALESCE(pg_catalog.jsonb_agg(p.name ORDER BY p.name), '[]'::pg_catalog.jsonb) AS report_rows
  FROM (SELECT c.relname::pg_catalog.text COLLATE pg_catalog."C" AS name FROM (${published}) AS c
    WHERE c.relname::pg_catalog.text COLLATE pg_catalog."C" ~ $3 AND c.relname::pg_catalog.text COLLATE pg_catalog."C" !~ $4
      AND c.relname::pg_catalog.text COLLATE pg_catalog."C" > $5
    ORDER BY name LIMIT $2::pg_catalog.int4) AS p`;
    return { ref, query, parameters: [schema, String(limit + 1), REPORT_NAME_SHAPE, REPORT_NAME_EXCLUSIONS, after ?? ''] };
  }
  const relation = `"${schema}"."${view}"`;
  // Same-statement, uncorrelated CASE guard: the row subquery is evaluated only for an actual
  // published VIEW, with the exact OID to which the qualified range reference resolves. No separate
  // list/preflight susceptible to a table substitution. Do not select entire rows, even transiently.
  const query = `SELECT $1::pg_catalog.text AS report_schema, $2::pg_catalog.text AS report_view,
  CASE WHEN EXISTS (SELECT 1 FROM (${published}) AS p WHERE p.relname = $2::pg_catalog.name AND p.oid = $3::pg_catalog.regclass)
  THEN (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('label', page.label, 'value', page.value)), '[]'::pg_catalog.jsonb)
    FROM (SELECT CASE WHEN pg_catalog.octet_length(r.label) BETWEEN 1 AND 200 THEN r.label END AS label,
      CASE WHEN pg_catalog.length(r.value::pg_catalog.text) BETWEEN 1 AND 32 THEN r.value::pg_catalog.text END AS value
      FROM ONLY ${relation} AS r LIMIT $4::pg_catalog.int4) AS page)
  ELSE NULL END AS report_rows`;
  return { ref, query, parameters: [schema, view, relation, String(limit)] };
}
