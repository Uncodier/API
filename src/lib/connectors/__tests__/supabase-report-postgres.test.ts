import { spawnSync } from 'node:child_process';
import { reportArguments } from '../supabase-report-query';
import { connectorFixture } from './composio-fixtures';

// A new WASM Postgres with synthetic roles/data only. No URLs, filesystem DB, provider or remote grants.
// Run outside Jest's VM so the bundled PGlite WASM can bootstrap normally.
test('actual SQL binds the tenant, role, publisher, object kind, column types, privileges and result limit', () => {
  const connector = { ...connectorFixture(), site_id: '00000000-0000-4000-8000-000000000001',
    toolkit_slug: 'supabase', supabase_project_ref: 'a'.repeat(20) };
  const list = reportArguments(connector, {}); const [schema] = list.parameters;
  const read = reportArguments(connector, { view: 'sales', limit: 1 });
  const first = reportArguments(connector, {limit:1});
  const next = reportArguments(connector, {limit:1, after:'sales'});
  const script = `
    import { PGlite } from '@electric-sql/pglite';
    import assert from 'node:assert/strict';
    const db = new PGlite(); const list = ${JSON.stringify(list)}; const read = ${JSON.stringify(read)};
    const execute = async q => {
      const rows = (await db.query(q.query, q.parameters)).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].report_schema, ${JSON.stringify(schema)});
      assert.equal(rows[0].report_view, q === read ? 'sales' : null);
      return rows[0].report_rows;
    };
    try {
      await db.exec(\`
        CREATE ROLE supabase_read_only_user; CREATE ROLE other_owner;
        CREATE SCHEMA ${schema} AUTHORIZATION postgres;
        CREATE SCHEMA makinari_reports_00000000000040008000000000000002 AUTHORIZATION postgres;
        CREATE VIEW makinari_reports_00000000000040008000000000000002.other AS SELECT 'Other'::text AS label, 999 AS value;
        CREATE VIEW ${schema}.sales AS SELECT * FROM (VALUES ('November'::text, 7::bigint, true), ('December', 9, false)) r(label,value,private_column);
        CREATE VIEW ${schema}.unreadable AS SELECT 'Private'::text AS label, 2 AS value;
        CREATE VIEW ${schema}.wrong_type AS SELECT 'Here'::text AS label, 'free text'::text AS value;
        CREATE VIEW ${schema}.tenant_owned AS SELECT 'Here'::text AS label, 2 AS value;
        ALTER VIEW ${schema}.tenant_owned OWNER TO other_owner;
        CREATE MATERIALIZED VIEW ${schema}.materialized AS SELECT 'Here'::text AS label, 2 AS value;
        GRANT USAGE ON SCHEMA ${schema}, makinari_reports_00000000000040008000000000000002 TO supabase_read_only_user;
        GRANT SELECT ON ALL TABLES IN SCHEMA ${schema}, makinari_reports_00000000000040008000000000000002 TO supabase_read_only_user;
        REVOKE SELECT ON ${schema}.unreadable FROM supabase_read_only_user;
        SET ROLE supabase_read_only_user;
      \`);
      assert.deepEqual(await execute(list), ['sales']);
      assert.deepEqual(await execute(read), [{ label: 'November', value: '7' }]);
      await db.exec('RESET ROLE');
      assert.deepEqual(await execute(list), []); assert.equal(await execute(read), null);
      await db.exec(\`
        DROP VIEW ${schema}.sales;
        CREATE TABLE ${schema}.sales (label text, value bigint);
        INSERT INTO ${schema}.sales VALUES ('Not published', 99);
        GRANT SELECT ON ${schema}.sales TO supabase_read_only_user;
        SET ROLE supabase_read_only_user;
      \`);
      assert.deepEqual(await execute(list), []); assert.equal(await execute(read), null);
      await db.exec(\`
        RESET ROLE; DROP TABLE ${schema}.sales;
        CREATE VIEW ${schema}.sales AS SELECT 'Foreign owner'::text AS label, 99 AS value;
        GRANT SELECT ON ${schema}.sales TO supabase_read_only_user;
        ALTER SCHEMA ${schema} OWNER TO other_owner; SET ROLE supabase_read_only_user;
      \`);
      assert.deepEqual(await execute(list), []); assert.equal(await execute(read), null);
      await db.exec(\`
        RESET ROLE; ALTER SCHEMA ${schema} OWNER TO postgres;
        CREATE VIEW ${schema}.weekly AS SELECT 'Item'::text AS label, 7::numeric AS value;
        CREATE VIEW ${schema}.daily AS SELECT 'Item'::text AS label, 2::int AS value;
        CREATE VIEW ${schema}.margin__quarterly AS SELECT 'Item'::text AS label, 3::int AS value;
        GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO supabase_read_only_user;
        REVOKE SELECT ON ${schema}.unreadable FROM supabase_read_only_user;
        SET ROLE supabase_read_only_user;
      \`);
      // Look ahead by one eligible name. A rejected publication name must not poison the page.
      assert.deepEqual(await execute(${JSON.stringify(first)}), ['daily', 'sales']);
      assert.deepEqual(await execute(${JSON.stringify(next)}), ['weekly']);
    } finally { await db.close(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr?.slice(-2500) || 'Local reporting SQL verification failed');
}, 35_000);
