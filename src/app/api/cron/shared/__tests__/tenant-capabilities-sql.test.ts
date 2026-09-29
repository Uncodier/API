import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationPath = 'supabase/migrations/20260929003000_apps_tenant_capabilities.sql';
const migration = readFileSync(resolve(process.cwd(), migrationPath), 'utf8');
const bootstrap = readFileSync(resolve(process.cwd(),
  'supabase/migrations/20260926080000_apps_tenant_idempotent_reprovision.sql'), 'utf8');

// Real in-memory PostgreSQL, no network, server, credentials or .env. A child
// process isolates PGlite's ESM/WASM loader from Jest. All SQL under test is read
// unchanged from the migration. PostgreSQL's postgres role is NOT a superuser.
function runPGlite(check: string, beforeMigration = '') {
  const script = `
    import assert from 'node:assert/strict';
    import { PGlite } from '@electric-sql/pglite';
    const db = new PGlite();
    const migration = ${JSON.stringify(migration)};
    const bootstrap = ${JSON.stringify(bootstrap)};
    const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
    const tenants = [1, 2].map(n => ({
      requirement: n + '1111111-2222-4333-8444-555555555555',
      id: id(n), user: id(10 + n), site: id(20 + n),
      schema: 'app_' + n + '11111112222433384445555',
      owner: 'app_owner_' + n + '11111112222433384445555',
    }));
    const names = ['_app_current_user_id', '_app_request_claims', '_app_is_backend_request'];
    const [a, b] = tenants;
    const role = async (name, action) => {
      await db.exec('SET ROLE ' + name);
      try { return await action(); }
      finally { await db.exec('RESET ROLE').catch(() => {}); }
    };
    const denied = async (sql) => assert.rejects(db.exec(sql), e => e.code === '42501');
    const claims = async (value = null, legacySub = '', legacyClaims = '') => db.query(
      "SELECT set_config('request.jwt.claims', $1, false), set_config('request.jwt.claim.sub', $2, false), set_config('request.jwt.claim', $3, false), set_config('request.jwt.claim.role', '', false)",
      [typeof value === 'string' ? value : value === null ? '' : JSON.stringify(value), legacySub, legacyClaims]
    );
    const signed = t => ({role: 'authenticated', tenant_id: t.id, schema: t.schema, sub: t.user});
    const rpc = async (t = a, install = true, requirement = t.requirement, tenantId = t.id) => {
      await db.query("SELECT set_config('request.jwt.claim.role', 'service_role', false)");
      try {
        return await role('service_role', async () => (await db.query(
          'SELECT public.apps_' + (install ? 'ensure' : 'get') + '_tenant_capabilities($1,$2) AS receipt',
          [requirement, tenantId]
        )).rows[0].receipt);
      } finally { await db.query("SELECT set_config('request.jwt.claim.role', '', false)").catch(() => {}); }
    };
    const read = async t => (await db.query('SELECT ' + t.schema + '._app_current_user_id() AS id, ' +
      t.schema + '._app_request_claims() AS claims, ' + t.schema + '._app_is_backend_request() AS backend')).rows[0];
    const snapshot = async () => ({
      registry: (await db.query('SELECT * FROM public.apps_tenants ORDER BY requirement_id')).rows,
      ledger: await Promise.all(tenants.map(async t => (await db.query('SELECT * FROM ' + t.schema + '._meta ORDER BY key')).rows)),
      funcs: (await db.query("SELECT p.oid, p.xmin::text, p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'app_%' ORDER BY p.oid")).rows,
      namespaces: (await db.query("SELECT oid, xmin::text, * FROM pg_namespace WHERE nspname LIKE 'app_%' ORDER BY oid")).rows,
    });
    const expected = (t, bucket = null) => ({
      version: 1, requirement_id: t.requirement, tenant_id: t.id, schema: t.schema,
      identity: {user_id: t.schema + '._app_current_user_id', claims: t.schema + '._app_request_claims', backend: t.schema + '._app_is_backend_request'},
      storage: {bucket, available: bucket !== null},
      backend: {role: 'authenticated', bypasses_rls: false, operations: []},
    });
    await db.exec(\`
      CREATE ROLE test_admin SUPERUSER LOGIN;
      SET SESSION AUTHORIZATION test_admin;
      ALTER ROLE postgres RENAME TO bootstrap_superuser;
      CREATE ROLE postgres LOGIN CREATEROLE CREATEDB;
      DO $grant$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO postgres', current_database()); END $grant$;
      CREATE ROLE apps_migration_coordinator NOLOGIN NOINHERIT;
      CREATE ROLE service_role NOLOGIN;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE unrelated NOLOGIN;
      GRANT apps_migration_coordinator TO postgres WITH INHERIT FALSE, SET TRUE;
      GRANT USAGE, CREATE ON SCHEMA public TO postgres;
      CREATE TABLE public.apps_tenants (
        tenant_id uuid PRIMARY KEY, requirement_id uuid NOT NULL UNIQUE,
        user_id uuid NOT NULL, site_id uuid NOT NULL, schema text NOT NULL,
        bucket text NOT NULL, auth_provider text NOT NULL, status text NOT NULL
      );
      ALTER TABLE public.apps_tenants OWNER TO postgres;
      ALTER TABLE public.apps_tenants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.apps_tenants FORCE ROW LEVEL SECURITY;
      CREATE POLICY service_only ON public.apps_tenants FOR ALL
        USING (current_setting('request.jwt.claim.role', true) = 'service_role')
        WITH CHECK (current_setting('request.jwt.claim.role', true) = 'service_role');
      CREATE TABLE public.tenant_users (tenant_id uuid, user_id uuid);
      REVOKE ALL ON TABLE public.apps_tenants, public.tenant_users FROM PUBLIC;
    \`);
    await role('postgres', () => db.exec(bootstrap));
    for (const t of tenants) {
      await db.query("SELECT set_config('request.jwt.claim.role', 'service_role', false)");
      await role('service_role', () => db.query('SELECT public.apps_ensure_tenant($1,$2,$3,$4,$5)',
        [t.requirement, t.id, t.user, t.site, 'supabase']));
      await db.exec("INSERT INTO " + t.schema + "._meta VALUES ('migration:already_applied.sql', '{\\"checksum\\":\\"untouched\\",\\"applied\\":true}', '2026-01-01T00:00:00Z')");
    }
    await claims();
    const before = await snapshot();
    const apply = async () => {
      try { await role('postgres', () => db.exec(migration)); }
      catch (error) { await db.exec('ROLLBACK; RESET ROLE'); throw error; }
    };
    ${beforeMigration}
    await apply();
    ${check}
    await db.close();
    console.log('ok');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 35_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.slice(-9_000) || result.error?.message || 'Offline PGlite capabilities check failed');
  }
  expect(result.stdout.trim()).toBe('ok');
}

describe('Apps tenant capabilities SQL (offline PostgreSQL)', () => {
  it('backfills and provisions exact minimal manifests with no auth schema dependency or ledger writes', () => {
    runPGlite(`
      assert.equal((await db.query("SELECT to_regnamespace('auth') AS auth")).rows[0].auth, null);
      assert.equal((await db.query("SELECT rolsuper FROM pg_roles WHERE rolname='postgres'")).rows[0].rolsuper, false);
      for (const t of tenants) assert.deepEqual(await rpc(t, false), expected(t));
      const after = await snapshot();
      assert.deepEqual(after.registry, before.registry);
      assert.deepEqual(after.ledger, before.ledger);
      const stable = await snapshot();
      for (let i = 0; i < 3; i++) for (const t of tenants) {
        assert.deepEqual(await rpc(t), expected(t));
        assert.deepEqual(await rpc(t, false), expected(t));
      }
      assert.deepEqual(await snapshot(), stable, 'idempotent calls must not even rewrite catalog xmin/ACL');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM public.tenant_users')).rows[0].n, 0);
      for (const t of tenants) {
        assert.equal((await db.query("SELECT has_schema_privilege($1,$2,'CREATE') AS allowed", ['apps_migration_coordinator', t.schema])).rows[0].allowed, false);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE member=$1::regrole', [t.owner])).rows[0].n, 0);
      }
      // A newly bootstrapped tenant after the one-time backfill receives nothing
      // until ensure is explicitly called. Its getter must never provision.
      const fresh = {...a, requirement: '31111111-2222-4333-8444-555555555555', id: id(3), schema: 'app_311111112222433384445555'};
      await db.query("SELECT set_config('request.jwt.claim.role','service_role',false)");
      await role('service_role', () => db.query('SELECT public.apps_ensure_tenant($1,$2,$3,$4,$5)',
        [fresh.requirement, fresh.id, fresh.user, fresh.site, 'supabase']));
      await assert.rejects(rpc(fresh, false), /Missing reserved/);
      assert.deepEqual(await rpc(fresh), expected(fresh));
      assert.deepEqual(await rpc(fresh, false), expected(fresh));
    `);
  }, 40_000);

  it('reads signed identity without role/claim mutation, membership, metadata trust, or cross-tenant backend authority', () => {
    runPGlite(`
      for (const t of tenants) await role(t.owner, () => db.exec(
        'CREATE TABLE ' + t.schema + '.members (user_id uuid PRIMARY KEY); ' +
        'CREATE TABLE ' + t.schema + '.records (id int); ' +
        'INSERT INTO ' + t.schema + '.records VALUES (1); ' +
        'ALTER TABLE ' + t.schema + '.records ENABLE ROW LEVEL SECURITY; ' +
        'CREATE POLICY member_only ON ' + t.schema + '.records TO authenticated USING (' +
          'EXISTS (SELECT 1 FROM ' + t.schema + '.members WHERE user_id=' + t.schema + '._app_current_user_id()) OR ' +
          t.schema + '._app_is_backend_request())'
      ));
      await claims(signed(a));
      await role('authenticated', async () => {
        const settings = (await db.query("SELECT current_user, current_setting('role') AS role, current_setting('request.jwt.claims') AS claims")).rows;
        assert.deepEqual(await read(a), {id: a.user, claims: signed(a), backend: true});
        assert.deepEqual(await read(b), {id: a.user, claims: signed(a), backend: false});
        assert.equal((await db.query('SELECT * FROM ' + a.schema + '.records')).rows.length, 1);
        assert.equal((await db.query('SELECT * FROM ' + b.schema + '.records')).rows.length, 0);
        assert.deepEqual((await db.query("SELECT current_user, current_setting('role') AS role, current_setting('request.jwt.claims') AS claims")).rows, settings);
        await denied('SELECT * FROM public.apps_tenants');
      });
      await claims(signed(b));
      await role('authenticated', async () => {
        assert.equal((await read(a)).backend, false);
        assert.equal((await read(b)).backend, true);
      });
      for (const invalid of [
        {sub: a.user},
        {...signed(a), sub: id(99)},
        {...signed(a), tenant_id: b.id},
        {...signed(a), schema: b.schema},
        {...signed(a), tenant_id: 'not-a-uuid'},
        {...signed(a), sub: 'not-a-uuid'},
        {...signed(a), role: 'anon'},
        {...signed(a), role: 'service_role'},
        {sub: id(99), user_metadata: signed(a)},
        {sub: id(99), app_metadata: signed(a)},
      ]) {
        await claims(invalid);
        await role('authenticated', async () => {
          assert.equal((await read(a)).backend, false);
          assert.equal((await db.query('SELECT * FROM ' + a.schema + '.records')).rows.length, 0, 'identity alone creates no membership');
        });
      }
      await claims({sub: id(99)});
      assert.equal((await db.query('SELECT count(*)::int AS n FROM ' + a.schema + '.members')).rows[0].n, 0);
      await db.query('INSERT INTO ' + a.schema + '.members VALUES ($1)', [id(99)]);
      await role('authenticated', async () => {
        assert.equal((await db.query('SELECT * FROM ' + a.schema + '.records')).rows.length, 1);
        assert.equal((await db.query('SELECT * FROM ' + b.schema + '.records')).rows.length, 0);
      });
      await claims();
      await role('anon', async () => assert.deepEqual(await read(a), {id: null, claims: null, backend: false}));
      await claims('{invalid json');
      await role('authenticated', async () => assert.deepEqual(await read(a), {id: null, claims: null, backend: false}));
      await claims({sub: 'malformed'});
      await role('authenticated', async () => assert.deepEqual(await read(a), {id: null, claims: {sub: 'malformed'}, backend: false}));
      await claims(signed(a), 'malformed');
      await role('authenticated', async () => {
        assert.equal((await read(a)).id, null);
        assert.equal((await read(a)).backend, false);
      });
      // Legacy auth.uid/auth.jwt precedence is preserved for read-only helpers.
      await claims(signed(b), a.user, JSON.stringify(signed(a)));
      await role('authenticated', async () => assert.deepEqual(await read(a), {id: a.user, claims: signed(a), backend: true}));
      await claims(signed(a), b.user);
      await role('authenticated', async () => assert.equal((await read(a)).backend, false));
    `);
  }, 40_000);

  it('keeps RPC ACLs privileged, getter truly read-only, and owner helpers invoker-only without auth or cross-schema grants', () => {
    runPGlite(`
      const internal = 'public._apps_tenant_capabilities(uuid,uuid,boolean)';
      for (const t of tenants) {
        for (const name of names) {
          const fn = t.schema + '.' + name + '()';
          const catalog = (await db.query(\`SELECT pg_get_userbyid(proowner) AS owner, prosecdef, provolatile, proconfig FROM pg_proc WHERE oid=$1::regprocedure\`, [fn])).rows[0];
          assert.deepEqual(catalog, {owner: 'apps_migration_coordinator', prosecdef: false, provolatile: 's', proconfig: ['search_path=pg_catalog']});
          for (const grantee of ['anon', 'authenticated', t.owner]) {
            assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [grantee, fn])).rows[0].allowed, true);
          }
          for (const grantee of ['service_role', 'unrelated', tenants.find(x => x !== t).owner]) {
            assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [grantee, fn])).rows[0].allowed, false);
          }
        }
      }
      for (const grantee of ['anon', 'authenticated', 'unrelated', a.owner, b.owner]) {
        await role(grantee, async () => {
          await denied("SELECT public.apps_ensure_tenant_capabilities('" + a.requirement + "','" + a.id + "')");
          await denied("SELECT public.apps_get_tenant_capabilities('" + a.requirement + "','" + a.id + "')");
          await denied("SELECT public._apps_tenant_capabilities('" + a.requirement + "','" + a.id + "',true)");
        });
      }
      assert.equal((await db.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS allowed", [internal])).rows[0].allowed, false);
      for (const name of ['apps_ensure_tenant_capabilities', 'apps_get_tenant_capabilities', '_apps_tenant_capabilities']) {
        assert.deepEqual((await db.query('SELECT pg_get_userbyid(proowner) AS owner, prosecdef FROM pg_proc WHERE proname=$1', [name])).rows[0], {owner:'postgres', prosecdef:true});
      }
      const stable = await snapshot();
      await db.exec('BEGIN READ ONLY');
      assert.deepEqual(await rpc(a, false), expected(a));
      await db.exec('COMMIT');
      assert.deepEqual(await snapshot(), stable);
      // An existing inaccessible auth schema must also remain entirely unchanged.
      await db.exec("CREATE SCHEMA auth; REVOKE ALL ON SCHEMA auth FROM PUBLIC; CREATE TABLE auth.users(id uuid); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'; REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC");
      const authAcl = (await db.query("SELECT nspacl FROM pg_namespace WHERE nspname='auth'")).rows;
      await rpc(a);
      assert.deepEqual((await db.query("SELECT nspacl FROM pg_namespace WHERE nspname='auth'")).rows, authAcl);
      await role(a.owner, async () => {
        await read(a);
        await denied('SELECT auth.uid()');
        await denied('SELECT * FROM auth.users');
        await denied('CREATE TABLE ' + b.schema + '.forbidden(id int)');
        await denied('SELECT ' + b.schema + '._app_request_claims()');
        await denied('ALTER FUNCTION ' + a.schema + '._app_current_user_id() IMMUTABLE');
        await denied('CREATE OR REPLACE FUNCTION ' + a.schema + "._app_current_user_id() RETURNS uuid LANGUAGE plpgsql STABLE AS 'BEGIN RETURN NULL; END'");
        await db.exec('GRANT EXECUTE ON FUNCTION ' + a.schema + '._app_current_user_id() TO unrelated').catch(e => assert.equal(e.code, '42501'));
        assert.equal((await db.query("SELECT has_function_privilege('unrelated',$1,'EXECUTE') AS allowed", [a.schema + '._app_current_user_id()'])).rows[0].allowed, false);
      });
      // Membership escalation tests must demote session_user as well as role.
      await db.exec('SET SESSION AUTHORIZATION ' + a.owner);
      await denied('SET ROLE authenticated');
      await denied('SET ROLE service_role');
      await denied('SET ROLE apps_migration_coordinator');
    `);
  }, 40_000);

  it('reports only the actual registry-bound storage bucket and never invents backend operations', () => {
    runPGlite(`
      assert.deepEqual((await rpc(a)).storage, {bucket: null, available: false});
      await db.exec('CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY, name text); GRANT USAGE ON SCHEMA storage TO postgres; GRANT SELECT ON storage.buckets TO postgres');
      assert.deepEqual((await rpc(a)).storage, {bucket: null, available: false});
      const bucket = 'real-custom-bucket';
      await db.query('UPDATE public.apps_tenants SET bucket=$1 WHERE tenant_id=$2', [bucket, a.id]);
      await db.query('INSERT INTO storage.buckets VALUES ($1,$2)', ['unrelated-bucket', bucket]);
      assert.deepEqual((await rpc(a)).storage, {bucket: null, available: false});
      await db.query('INSERT INTO storage.buckets VALUES ($1,$2)', [bucket, 'display name is not the bucket id']);
      assert.deepEqual(await rpc(a), expected(a, bucket));
      assert.deepEqual(await rpc(a, false), expected(a, bucket));
      await role(a.owner, () => db.exec('CREATE FUNCTION ' + a.schema + ".arbitrary_business_operation() RETURNS text LANGUAGE sql SECURITY INVOKER AS 'SELECT ''secret''::text'"));
      assert.deepEqual((await rpc(a)).backend.operations, []);
      assert.deepEqual((await rpc(b)).storage, {bucket: null, available: false});
      await db.query('DELETE FROM storage.buckets WHERE id=$1', [bucket]);
      assert.deepEqual((await rpc(a, false)).storage, {bucket: null, available: false});
      await db.exec('DROP SCHEMA storage CASCADE');
      assert.deepEqual((await rpc(a, false)).storage, {bucket: null, available: false});
    `);
  }, 40_000);

  it('rejects conflicts in owner/body/config/signature/ACL, never trusts metadata, and only repairs missing helpers', () => {
    runPGlite(`
      const fn = a.schema + '._app_current_user_id()';
      const other = a.schema + '._app_request_claims()';
      const original = (await db.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure', [fn])).rows[0].prosrc;
      for (const mutation of [
        'ALTER FUNCTION ' + fn + ' OWNER TO ' + a.owner,
        'ALTER FUNCTION ' + fn + ' SECURITY DEFINER',
        'ALTER FUNCTION ' + fn + ' SET search_path=public',
        'ALTER FUNCTION ' + fn + ' IMMUTABLE',
        'ALTER FUNCTION ' + fn + ' STRICT',
        'GRANT EXECUTE ON FUNCTION ' + fn + ' TO PUBLIC',
        'GRANT EXECUTE ON FUNCTION ' + fn + ' TO unrelated',
        'REVOKE EXECUTE ON FUNCTION ' + fn + ' FROM ' + a.owner,
        'CREATE FUNCTION ' + a.schema + "._app_current_user_id(text DEFAULT '') RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'",
        'CREATE OR REPLACE FUNCTION ' + fn + " RETURNS uuid LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS 'BEGIN RETURN NULL; END;'",
      ]) {
        await db.exec('BEGIN');
        await db.exec(mutation);
        // Copy the expected body into metadata: it must not fool the verifier.
        await db.query("SELECT format('COMMENT ON FUNCTION %s IS %L', $1::text,$2::text) AS sql", [fn, original]).then(r => db.exec(r.rows[0].sql));
        const changed = await snapshot();
        await db.exec('SAVEPOINT check_get');
        await assert.rejects(rpc(a, false), /Conflicting reserved/);
        await db.exec('ROLLBACK TO SAVEPOINT check_get');
        await db.exec('SAVEPOINT check_ensure');
        await assert.rejects(rpc(a), /Conflicting reserved/);
        await db.exec('ROLLBACK TO SAVEPOINT check_ensure');
        assert.deepEqual(await snapshot(), changed);
        await db.exec('ROLLBACK');
      }
      // PostgreSQL really permits DROP by the schema owner. Do not pretend
      // coordinator ownership prevents it; it DOES prevent replacing/altering.
      const ledger = (await snapshot()).ledger;
      await role(a.owner, () => db.exec('DROP FUNCTION ' + other));
      await assert.rejects(rpc(a, false), /Missing reserved/);
      assert.equal((await db.query('SELECT to_regprocedure($1) AS fn', [other])).rows[0].fn, null);
      assert.deepEqual(await rpc(a), expected(a));
      assert.deepEqual((await snapshot()).ledger, ledger);
      await role(a.owner, () => db.exec('DROP FUNCTION ' + other));
      await role(a.owner, () => db.exec('CREATE FUNCTION ' + other + " RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS 'BEGIN RETURN NULL; END;'"));
      await assert.rejects(rpc(a), /Conflicting reserved/);
      assert.deepEqual((await snapshot()).ledger, ledger);
    `);
  }, 40_000);

  it('fails closed on registry, isolated role and bootstrap drift', () => {
    runPGlite(`
      for (const [req, tenant] of [[null,a.id],[a.requirement,null],[b.requirement,a.id],[id(99),a.id]]) {
        await assert.rejects(rpc(a,true,req,tenant), /Invalid tenant capability request|registry binding/);
      }
      for (const mutation of [
        "UPDATE public.apps_tenants SET status='suspended' WHERE tenant_id='" + a.id + "'",
        "UPDATE public.apps_tenants SET schema='app_invalid' WHERE tenant_id='" + a.id + "'",
        "UPDATE public.apps_tenants SET user_id='" + b.user + "' WHERE tenant_id='" + a.id + "'",
        'ALTER SCHEMA ' + a.schema + ' OWNER TO ' + b.owner,
        'ALTER ROLE ' + a.owner + ' LOGIN',
        'ALTER ROLE ' + a.owner + ' INHERIT',
        'ALTER ROLE ' + a.owner + ' BYPASSRLS',
        'GRANT authenticated TO ' + a.owner,
        'ALTER TABLE ' + a.schema + '._meta DISABLE ROW LEVEL SECURITY',
      ]) {
        await db.exec('BEGIN'); await db.exec(mutation); await db.exec('SAVEPOINT attempt');
        await assert.rejects(rpc(a), /registry binding|owner roles|Conflicting reserved|complete isolated bootstrap/);
        await db.exec('ROLLBACK TO SAVEPOINT attempt'); await db.exec('ROLLBACK');
      }
      assert.deepEqual((await snapshot()).ledger, before.ledger);
    `);
  }, 40_000);

  it('rolls the entire backfill back on a later-tenant conflict and preserves legacy function bodies', () => {
    runPGlite(`
      assert.deepEqual((await snapshot()).ledger, before.ledger);
      assert.deepEqual(await rpc(a, false), expected(a));
      assert.deepEqual(await rpc(b, false), expected(b));
      assert.deepEqual((await db.query('SELECT oid, xmin::text, prosrc FROM pg_proc WHERE oid=$1::regprocedure',
        [a.schema + '.current_user_id()'])).rows, legacy);
      assert.deepEqual((await db.query("SELECT oid, xmin::text, prosrc FROM pg_proc WHERE oid='public.apps_ensure_tenant(uuid,uuid,uuid,uuid,text)'::regprocedure")).rows, provisioner);
    `, `
      await role(a.owner, () => db.exec('CREATE FUNCTION ' + a.schema + ".current_user_id() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'"));
      const legacy = (await db.query('SELECT oid, xmin::text, prosrc FROM pg_proc WHERE oid=$1::regprocedure',
        [a.schema + '.current_user_id()'])).rows;
      const provisioner = (await db.query("SELECT oid, xmin::text, prosrc FROM pg_proc WHERE oid='public.apps_ensure_tenant(uuid,uuid,uuid,uuid,text)'::regprocedure")).rows;
      await role(b.owner, () => db.exec('CREATE FUNCTION ' + b.schema + "._app_is_backend_request() RETURNS boolean LANGUAGE sql AS 'SELECT true'"));
      const conflicted = await snapshot();
      await assert.rejects(apply(), /Conflicting reserved/);
      assert.deepEqual(await snapshot(), conflicted, 'failed backfill must roll back earlier tenant helpers and temporary CREATE grants');
      assert.equal((await db.query("SELECT to_regprocedure('public.apps_ensure_tenant_capabilities(uuid,uuid)') AS fn")).rows[0].fn, null);
      assert.equal((await db.query("SELECT to_regprocedure('public.apps_get_tenant_capabilities(uuid,uuid)') AS fn")).rows[0].fn, null);
      await role(b.owner, () => db.exec('DROP FUNCTION ' + b.schema + '._app_is_backend_request()'));
    `);
  }, 40_000);
});