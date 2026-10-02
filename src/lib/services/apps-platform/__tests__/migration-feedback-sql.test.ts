import { spawnSync } from 'node:child_process';

// Real PostgreSQL catalog/ACL/RLS execution, entirely offline. A subprocess
// avoids Jest's ESM/WASM loader; no Next config, credentials or remote DB loads.
const fixture = String.raw`
  import assert from 'node:assert/strict';
  import { readFileSync } from 'node:fs';
  import { createHash } from 'node:crypto';
  import { PGlite } from '@electric-sql/pglite';
  const db = new PGlite();
  const migration = readFileSync('supabase/migrations/20261002100000_apps_migration_feedback.sql', 'utf8');
  const atomic = readFileSync('supabase/migrations/20260923194000_apply_tenant_migration_atomically.sql', 'utf8');
  const a = { schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', tenant: '10000000-0000-4000-8000-000000000001' };
  const b = { schema: 'app_bbbbbbbbbbbbbbbbbbbbbbbb', tenant: '10000000-0000-4000-8000-000000000002' };
  const owner = 'app_owner_aaaaaaaaaaaaaaaaaaaaaaaa';
  const key = 'migration:supabase/migrations/001_records.sql';
  const hash = text => createHash('sha256').update(text).digest('hex');
  const checksum = hash('offline candidate');
  const context = hash('offline host policy and schema context');
  const diagnostic = { file: key.slice('migration:'.length), code: '42601', kind: 'sql', message: 'Syntax error near SELECT' };
  async function asRole(role, callback) {
    assert.ok(['anon', 'authenticated', 'service_role', owner].includes(role));
    await db.query("SELECT set_config('request.jwt.claim.role', $1, false)", [role]);
    await db.exec('SET ROLE ' + role);
    try { return await callback(); }
    finally {
      await db.exec('RESET ROLE');
      await db.exec("SELECT set_config('request.jwt.claim.role', '', false)");
    }
  }
  const workspace = (schema = a.schema, tenant = a.tenant) => db.query(
    'SELECT public.apps_get_migration_workspace($1, $2) AS value', [schema, tenant],
  ).then(result => result.rows[0].value);
  const reload = (schema = a.schema, tenant = a.tenant) => db.query(
    'SELECT public.apps_reload_migration_schema($1, $2) AS value', [schema, tenant],
  );
  const record = (overrides = {}) => {
    const args = { schema: a.schema, tenant: a.tenant, key, checksum, context, error: null, ...overrides };
    return db.query('SELECT * FROM public.apps_record_migration_feedback($1, $2, $3, $4, $5, $6)',
      [args.schema, args.tenant, args.key, args.checksum, args.context,
        args.error === null ? null : JSON.stringify(args.error)]).then(result => result.rows[0]);
  };
  const apply = (migrationKey, sql) => db.query(
    'SELECT public.apps_apply_migration($1, $2, $3, $4, $5) AS applied',
    [a.schema, a.tenant, migrationKey, hash(sql), sql],
  ).then(result => result.rows[0].applied);
  const denied = callback => assert.rejects(callback, /permission denied|must be owner/);
  await db.exec(
    'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;'
    + 'CREATE ROLE installer NOLOGIN CREATEROLE;'
    + 'GRANT CREATE ON DATABASE postgres TO installer;'
    + 'GRANT USAGE, CREATE ON SCHEMA public TO installer WITH GRANT OPTION;'
    + 'SET ROLE installer;'
    + 'CREATE TABLE public.apps_tenants(tenant_id uuid PRIMARY KEY, schema text NOT NULL, status text NOT NULL);'
    + 'ALTER TABLE public.apps_tenants ENABLE ROW LEVEL SECURITY;'
    + "CREATE POLICY registry_service ON public.apps_tenants USING (current_setting('request.jwt.claim.role', true) = 'service_role');"
    // Reproduce Supabase-style default grants: the new migration must revoke
    // these, not assume that a freshly created public object is already private.
    + 'ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated, service_role;'
    + 'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;'
  );
  for (const tenant of [a, b]) {
    await db.query("INSERT INTO public.apps_tenants VALUES ($1, $2, 'active')", [tenant.tenant, tenant.schema]);
    await db.exec('CREATE SCHEMA ' + tenant.schema + ';'
      + 'CREATE TABLE ' + tenant.schema + '._meta(key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());'
      + 'ALTER TABLE ' + tenant.schema + '._meta ENABLE ROW LEVEL SECURITY;'
      + 'REVOKE ALL ON ' + tenant.schema + '._meta FROM PUBLIC, anon, authenticated, service_role;'
      + 'CREATE TABLE ' + tenant.schema + '.records(id integer PRIMARY KEY, body text);');
  }
  await db.exec('RESET ROLE');
  await db.exec(atomic);
  await db.exec('GRANT apps_migration_coordinator TO installer WITH INHERIT FALSE, SET TRUE; SET ROLE installer');
  const originalApply = (await db.query("SELECT pg_get_functiondef('public.apps_apply_migration(text,uuid,text,text,text)'::regprocedure) AS body")).rows[0].body;
  await db.exec(migration);
  assert.equal((await db.query("SELECT pg_get_functiondef('public.apps_apply_migration(text,uuid,text,text,text)'::regprocedure) AS body")).rows[0].body, originalApply);
  await db.exec('RESET ROLE');
`;

function runOffline(body: string) {
  const reportError = `process.on('uncaughtException', error => {
    console.error(JSON.stringify({message: error.message, code: error.code, where: error.where, query: error.query?.slice(0, 200), stack: error.stack}));
    process.exit(1);
  });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `${reportError}\n${fixture}\n${body}\nawait db.close();`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.slice(-12_000) || result.error?.message || 'Offline migration feedback SQL failed');
  }
}

describe('Apps observed migration feedback SQL', () => {
  it('holds the same transaction-scoped tenant stream advisory lock as atomic apply', () => {
    runOffline(String.raw`
      for (const operation of [() => workspace(), () => record(), () => reload(),
        () => apply(key, 'CREATE TABLE lock_probe(id integer);')]) {
        await db.exec('BEGIN');
        await asRole('service_role', operation);
        const locks = (await db.query(
          "SELECT count(*)::integer AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory'"
          + " AND pid = pg_backend_pid() AND granted AND mode = 'ExclusiveLock' AND objsubid = 1"
          + ' AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)', [a.schema],
        )).rows[0].n;
        assert.equal(locks, 1, 'workspace, feedback, reload and apply share one whole-schema lock');
        await db.exec('ROLLBACK');
        assert.equal((await db.query("SELECT count(*)::integer AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()")).rows[0].n, 0);
      }
    `);
  }, 35_000);

  it('authorizes fixed PostgREST schema reload only for service and the active isolated tenant', () => {
    runOffline(String.raw`
      const notifications = [];
      const stopListening = await db.listen('pgrst', payload => notifications.push(payload));
      for (const role of ['anon', 'authenticated', owner]) {
        await asRole(role, () => denied(() => reload()));
      }
      const definition = (await db.query(
        "SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig, prorettype::regtype::text AS return_type"
        + " FROM pg_catalog.pg_proc WHERE oid = 'public.apps_reload_migration_schema(text,uuid)'::regprocedure",
      )).rows[0];
      assert.deepEqual(definition, {
        owner: 'apps_migration_coordinator', prosecdef: true,
        proconfig: ['search_path=pg_catalog'], return_type: 'void',
      });
      await asRole('service_role', async () => {
        for (const [schema, tenant] of [[null, a.tenant], [a.schema, null], ['public', a.tenant],
          [a.schema, b.tenant], [b.schema, a.tenant], ['app_cccccccccccccccccccccccc', a.tenant]]) {
          await assert.rejects(() => reload(schema, tenant), /binding|active tenant/);
        }
        const before = await workspace();
        const result = await reload();
        assert.equal(result.rows.length, 1);
        assert.ok(Object.prototype.hasOwnProperty.call(result.rows[0], 'value'));
        await reload(); // A confirmed apply retry may repeat cache invalidation.
        assert.deepEqual(await workspace(), before, 'reload adds no state and rewrites no receipts');
      });
      assert.deepEqual(notifications, ['reload schema', 'reload schema']);
      await db.exec("UPDATE public.apps_tenants SET status = 'suspended' WHERE schema = '" + a.schema + "'");
      await asRole('service_role', () => assert.rejects(() => reload(), /active tenant/));
      await db.exec("UPDATE public.apps_tenants SET status = 'active' WHERE schema = '" + a.schema + "'");
      await db.exec('ALTER TABLE ' + a.schema + '._meta OWNER TO ' + owner);
      await asRole('service_role', () => assert.rejects(() => reload(), /protected receipts/));
      assert.deepEqual(notifications, ['reload schema', 'reload schema'], 'invalid scope never notifies');
      await stopListening();
    `);
  }, 35_000);

  it('restricts both RPCs to service and table access to service SELECT, with effective RLS', () => {
    runOffline(String.raw`
      const saved = await asRole('service_role', () => record({ error: diagnostic }));
      assert.deepEqual(Object.keys(saved).sort(), ['target_schema', 'migration_key', 'tenant_id', 'checksum', 'context_key', 'error', 'updated_at'].sort());
      assert.equal(saved.target_schema, a.schema);
      assert.deepEqual(saved.error, diagnostic);
      for (const role of ['anon', 'authenticated', owner]) {
        await asRole(role, async () => {
          // A forged service claim never substitutes for the SQL role ACL.
          await db.exec("SELECT set_config('request.jwt.claim.role', 'service_role', false)");
          await denied(() => workspace());
          await denied(() => record());
          await denied(() => db.query('SELECT * FROM public.apps_migration_feedback'));
          await denied(() => db.exec('ALTER TABLE public.apps_migration_feedback DISABLE ROW LEVEL SECURITY'));
          await denied(() => db.exec('DROP TABLE public.apps_migration_feedback CASCADE'));
          assert.equal((await db.query("SELECT pg_has_role(current_user, 'apps_migration_coordinator', 'MEMBER') AS member")).rows[0].member, false);
        });
      }
      await asRole('service_role', async () => {
        assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.apps_migration_feedback')).rows[0].n, 1);
        for (const sql of [
          'UPDATE public.apps_migration_feedback SET error = NULL',
          'DELETE FROM public.apps_migration_feedback',
          'TRUNCATE public.apps_migration_feedback',
          'INSERT INTO public.apps_migration_feedback SELECT * FROM public.apps_migration_feedback',
        ]) await denied(() => db.exec(sql));
        await denied(() => apply('migration:migrations/002_attack.sql', 'ALTER TABLE public.apps_migration_feedback DISABLE ROW LEVEL SECURITY;'));
        assert.equal((await workspace()).receipts.length, 0, 'tenant SQL cannot change protected feedback');
      });
      // Even accidental SELECT grants do not expose feedback through RLS.
      await db.exec('GRANT SELECT ON public.apps_migration_feedback TO anon, authenticated, ' + owner);
      for (const role of ['anon', 'authenticated', owner]) {
        await asRole(role, async () => {
          await db.exec("SELECT set_config('request.jwt.claim.role', 'service_role', false)");
          assert.deepEqual((await db.query('SELECT * FROM public.apps_migration_feedback')).rows, []);
        });
      }
      const acl = (await db.query("SELECT c.relrowsecurity, pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid = 'public.apps_migration_feedback'::regclass")).rows[0];
      assert.deepEqual(acl, { relrowsecurity: true, owner: 'apps_migration_coordinator' });
      assert.equal((await db.query("SELECT has_schema_privilege('apps_migration_coordinator','public','CREATE') AS allowed")).rows[0].allowed, false);
    `);
  }, 35_000);

  it('fails closed on null, missing, wrong, inactive and structurally untrusted tenant bindings', () => {
    runOffline(String.raw`
      await asRole('service_role', async () => {
        for (const [schema, tenant] of [
          [null, a.tenant], [a.schema, null], ['public', a.tenant],
          ['app_cccccccccccccccccccccccc', a.tenant], [a.schema, b.tenant], [b.schema, a.tenant],
          [a.schema, '10000000-0000-4000-8000-000000000099'],
        ]) {
          await assert.rejects(() => workspace(schema, tenant), /binding|active tenant/);
          await assert.rejects(() => record({ schema, tenant }), /payload|active tenant/);
        }
        assert.deepEqual((await workspace()).files, []);
      });
      await db.exec("UPDATE public.apps_tenants SET status = 'suspended' WHERE schema = '" + a.schema + "'");
      await asRole('service_role', async () => {
        await assert.rejects(() => workspace(), /active tenant/);
        await assert.rejects(() => record(), /active tenant/);
      });
      await db.exec("UPDATE public.apps_tenants SET status = 'active' WHERE schema = '" + a.schema + "'");
      await db.exec('ALTER TABLE ' + a.schema + '._meta OWNER TO ' + owner);
      await asRole('service_role', async () => {
        await assert.rejects(() => workspace(), /protected receipts/);
        await assert.rejects(() => record(), /protected receipts/);
      });
      await db.exec('ALTER TABLE ' + a.schema + '._meta OWNER TO apps_migration_coordinator; ALTER ROLE ' + owner + ' LOGIN');
      await asRole('service_role', async () => {
        await assert.rejects(() => workspace(), /isolated schema/);
        await assert.rejects(() => record(), /isolated schema/);
      });
      await db.exec('ALTER ROLE ' + owner + ' NOLOGIN; DROP SCHEMA ' + a.schema + ' CASCADE');
      await asRole('service_role', async () => {
        await assert.rejects(() => workspace(), /isolated schema/);
        await assert.rejects(() => record(), /isolated schema/);
      });
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.apps_migration_feedback')).rows[0].n, 0);
    `);
  }, 35_000);

  it('validates canonical paths, checksums, context and byte-bounded diagnostic payloads', () => {
    runOffline(String.raw`
      await asRole('service_role', async () => {
        const invalidKeys = [null, '', 'migration:001.sql', 'migration:test/001.sql',
          'migrations/001.sql', 'migration:migrations/../001.sql', 'migration:migrations/./001.sql',
          'migration:platform/a/../../001.sql', 'migration:migrations//001.sql',
          'migration:migrations/.hidden.sql', 'migration:migrations/.hidden/001.sql',
          'migration:migrations/001.SQL', 'migration:migrations/001.sql/extra',
          'migration:migrations/a\\001.sql', 'migration:migrations/%2e%2e/001.sql',
          'migration:migrations/' + 'a'.repeat(498) + '.sql'];
        for (const invalid of invalidKeys) await assert.rejects(() => record({ key: invalid }), /Invalid migration feedback payload/);
        for (const invalid of [null, '', 'z'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
          await assert.rejects(() => record({ checksum: invalid }), /Invalid migration feedback payload/);
        }
        for (const invalid of [null, '', 'x'.repeat(257), '🙂'.repeat(65)]) {
          await assert.rejects(() => record({ context: invalid }), /Invalid migration feedback payload/);
        }
        for (const invalid of ['text', 1, [], { message: 'x'.repeat(4096) }, { message: '🙂'.repeat(1100) }]) {
          await assert.rejects(() => record({ error: invalid }), /Invalid migration feedback payload/);
        }
        await assert.rejects(() => db.query('SELECT public.apps_record_migration_feedback($1,$2,$3,$4,$5,$6)',
          [a.schema, a.tenant, key, checksum, context, 'null']), /Invalid migration feedback payload/);
        assert.deepEqual((await workspace()).files, []);
        for (const root of ['migrations', 'supabase/migrations', 'src/db/migrations', 'platform']) {
          await record({ key: 'migration:' + root + '/nested/001_records.sql' });
        }
        // Omitting p_error uses SQL NULL, not JSON null.
        const saved = (await db.query('SELECT * FROM public.apps_record_migration_feedback($1,$2,$3,$4,$5)',
          [a.schema, a.tenant, key, checksum, context])).rows[0];
        assert.equal(saved.error, null);
        assert.equal((await workspace()).files.length, 5);
      });
    `);
  }, 35_000);

  it('durably retains observed names and diagnostics, replacing only never-applied candidates', () => {
    runOffline(String.raw`
      await asRole('service_role', async () => {
        await record({ error: diagnostic });
        await record({ key: 'migration:migrations/002_seen.sql' });
      });
      // A fresh caller/workspace has no sandbox-local file or process state.
      await asRole('service_role', async () => {
        const first = await workspace();
        assert.deepEqual(Object.keys(first).sort(), ['files', 'receipts', 'schema_fingerprint']);
        assert.deepEqual(first.receipts, []);
        assert.deepEqual(first.files, [
          { migration_key: 'migration:migrations/002_seen.sql', checksum, context_key: context, error: null },
          { migration_key: key, checksum, context_key: context, error: diagnostic },
        ]);
        assert.deepEqual((await workspace(b.schema, b.tenant)).files, []);
        const nextChecksum = hash('fixed candidate');
        const nextContext = hash('new schema context');
        const replaced = await record({ checksum: nextChecksum, context: nextContext });
        assert.equal(replaced.checksum, nextChecksum);
        assert.equal(replaced.context_key, nextContext);
        assert.equal(replaced.error, null);
        const next = await workspace();
        assert.equal(next.files.length, 2);
        assert.equal(next.files.find(file => file.migration_key === key).checksum, nextChecksum);
        assert.equal(next.schema_fingerprint, first.schema_fingerprint, 'feedback writes are not structural changes');
      });
      // A registry reassignment must not silently adopt another tenant's journal.
      await db.exec("UPDATE public.apps_tenants SET tenant_id = '10000000-0000-4000-8000-000000000099' WHERE schema = '" + a.schema + "'");
      await asRole('service_role', async () => {
        const tenant = '10000000-0000-4000-8000-000000000099';
        await assert.rejects(() => workspace(a.schema, tenant), /binding changed/);
        await assert.rejects(() => record({ tenant }), /binding changed/);
        await assert.rejects(() => record({ tenant, key: 'migration:migrations/unobserved.sql' }), /binding changed/);
      });
    `);
  }, 35_000);

  it('treats every applied receipt as authoritative and never edits receipts or applied feedback', () => {
    runOffline(String.raw`
      const sql = 'CREATE TABLE applied_records(id integer);';
      await asRole('service_role', async () => {
        await record({ checksum: hash(sql), error: diagnostic });
        assert.equal(await apply(key, sql), true);
      });
      await db.query('INSERT INTO ' + a.schema + '._meta(key,value) VALUES ($1,$2),($3,$4),($5,$6)', [
        'migration:legacy/location.sql', { applied_at: 'offline fixture', checksum: hash('legacy SQL') },
        'migration:migrations/no_checksum.sql', { applied_at: 'offline fixture' },
        'provisioning:unrelated', { version: 1 },
      ]);
      const beforeReceipts = (await db.query('SELECT * FROM ' + a.schema + '._meta ORDER BY key')).rows;
      const beforeFeedback = (await db.query('SELECT * FROM public.apps_migration_feedback')).rows;
      await asRole('service_role', async () => {
        const matched = await record({ checksum: hash(sql), context: hash('later run') });
        assert.equal(matched.checksum, hash(sql));
        await assert.rejects(() => record({ checksum: hash('changed SQL') }), /changed after application/);
        await assert.rejects(() => record({ key: 'migration:migrations/no_checksum.sql' }), /no verifiable checksum/);
        const current = await workspace();
        assert.equal(current.files[0].error.message, diagnostic.message, 'an old diagnostic is not redundant applied state');
        assert.deepEqual(current.receipts.map(row => row.migration_key), [
          'migration:legacy/location.sql', 'migration:migrations/no_checksum.sql', key,
        ]);
        assert.equal(current.receipts.find(row => row.migration_key === key).value.checksum, hash(sql));
        assert.equal(current.receipts.find(row => row.migration_key === 'migration:migrations/no_checksum.sql').value.checksum, undefined);
      });
      assert.deepEqual((await db.query('SELECT * FROM ' + a.schema + '._meta ORDER BY key')).rows, beforeReceipts);
      assert.deepEqual((await db.query('SELECT * FROM public.apps_migration_feedback')).rows, beforeFeedback);
      // An already-applied file with no prior observation does not create one.
      await db.query('INSERT INTO ' + a.schema + '._meta(key,value) VALUES ($1,$2)', [
        'migration:platform/applied.sql', { checksum },
      ]);
      await asRole('service_role', () => record({ key: 'migration:platform/applied.sql' }));
      assert.deepEqual((await db.query('SELECT * FROM public.apps_migration_feedback')).rows, beforeFeedback);
    `);
  }, 35_000);

  it('propagates failed journal persistence and preserves the last durable diagnostic', () => {
    runOffline(String.raw`
      await asRole('service_role', async () => {
        await assert.rejects(() => apply(key, 'CREATE TABLE records(id integer);'), /already exists/);
        await record({ error: diagnostic });
        const state = await workspace();
        assert.deepEqual(state.receipts, [], 'failed SQL is never an applied receipt');
        assert.deepEqual(state.files[0].error, diagnostic);
      });
      await db.exec("CREATE FUNCTION public.reject_feedback_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'offline persistence failure'; END$$;"
        + 'CREATE TRIGGER reject_write BEFORE INSERT OR UPDATE ON public.apps_migration_feedback FOR EACH ROW EXECUTE FUNCTION public.reject_feedback_write();');
      await asRole('service_role', async () => {
        await assert.rejects(() => record({ checksum: hash('candidate replacement') }), /offline persistence failure/);
        await assert.rejects(() => record({ key: 'migration:migrations/other.sql' }), /offline persistence failure/);
        const state = await workspace();
        assert.equal(state.files.length, 1);
        assert.equal(state.files[0].checksum, checksum);
        assert.deepEqual(state.files[0].error, diagnostic);
        assert.deepEqual(state.receipts, []);
      });
    `);
  }, 35_000);

  it('fingerprints catalog structure, policies, routines, grants and role capabilities but never row data', () => {
    runOffline(String.raw`
      const fingerprint = () => asRole('service_role', async () => (await workspace()).schema_fingerprint);
      let previous = await fingerprint();
      assert.match(previous, /^[a-f0-9]{32}$/);
      assert.equal(await fingerprint(), previous);
      for (const ddl of [
        'ALTER TABLE ' + a.schema + '.records ADD COLUMN created_at timestamptz DEFAULT now()',
        'ALTER TABLE ' + a.schema + '.records ENABLE ROW LEVEL SECURITY',
        'CREATE POLICY visible_records ON ' + a.schema + '.records FOR SELECT TO authenticated USING (id > 0)',
        'ALTER POLICY visible_records ON ' + a.schema + '.records USING (id > 1)',
        'CREATE FUNCTION ' + a.schema + '.answer() RETURNS integer LANGUAGE sql AS $$SELECT 1$$',
        'CREATE OR REPLACE FUNCTION ' + a.schema + '.answer() RETURNS integer LANGUAGE sql AS $$SELECT 2$$',
        'REVOKE ALL ON ' + a.schema + '.records FROM anon',
        'GRANT SELECT (body) ON ' + a.schema + '.records TO anon',
        'REVOKE EXECUTE ON FUNCTION ' + a.schema + '.answer() FROM PUBLIC',
        'GRANT USAGE ON SCHEMA ' + a.schema + ' TO authenticated',
        'CREATE TYPE ' + a.schema + '.mood AS ENUM ($$one$$, $$two$$)',
        'ALTER TYPE ' + a.schema + '.mood ADD VALUE $$three$$',
        'CREATE SEQUENCE ' + a.schema + '.counter START 10',
        'ALTER SEQUENCE ' + a.schema + '.counter INCREMENT 2',
        'ALTER DEFAULT PRIVILEGES FOR ROLE ' + owner + ' IN SCHEMA ' + a.schema + ' REVOKE ALL ON TABLES FROM anon',
        'ALTER ROLE authenticated CONNECTION LIMIT 5',
      ]) {
        await db.exec(ddl);
        const next = await fingerprint();
        assert.notEqual(next, previous, ddl);
        assert.equal(await fingerprint(), next, 'deterministic repeated catalog read');
        previous = next;
      }
      await db.exec('INSERT INTO ' + a.schema + '.records(id,body) VALUES (10,$$unobserved tenant row$$);'
        + 'UPDATE ' + a.schema + '.records SET body = $$different data$$;'
        + "SELECT nextval('" + a.schema + ".counter');"
        + 'ALTER TABLE ' + b.schema + '.records ADD COLUMN unrelated boolean;');
      await db.query('INSERT INTO ' + a.schema + '._meta(key,value) VALUES ($1,$2)', [key, { checksum }]);
      await asRole('service_role', () => record({ key: 'migration:migrations/observed.sql', error: diagnostic }));
      assert.equal(await fingerprint(), previous, 'data, receipt/journal writes, counters and another schema are excluded');
      await db.exec('DELETE FROM ' + a.schema + '.records');
      assert.equal(await fingerprint(), previous);
    `);
  }, 35_000);
});