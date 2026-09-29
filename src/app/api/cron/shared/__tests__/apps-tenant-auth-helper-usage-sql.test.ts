import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const previousMigration = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260926080000_apps_tenant_idempotent_reprovision.sql',
), 'utf8');
const forwardMigration = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260928235000_apps_tenant_auth_helper_usage.sql',
), 'utf8');

// A child process avoids Jest's ESM/WASM loader; no server, network, or .env.
function runPGlite(check: string) {
  const script = `
    import assert from 'node:assert/strict';
    import { PGlite } from '@electric-sql/pglite';
    const db = new PGlite();
    const migration = ${JSON.stringify(forwardMigration)};
    const previousMigration = ${JSON.stringify(previousMigration)};
    const req = '11111111-2222-4333-8444-555555555555';
    const schema = 'app_111111112222433384445555';
    const owner = 'app_owner_111111112222433384445555';
    const user = '00000000-0000-4000-8000-000000000002';
    const args = [req, '00000000-0000-4000-8000-000000000001', user,
      '00000000-0000-4000-8000-000000000003', 'supabase'];
    const ensure = async (values = args) => {
      await db.exec('SET ROLE service_role');
      try {
        const result = await db.query('SELECT public.apps_ensure_tenant($1,$2,$3,$4,$5) AS receipt', values);
        return result.rows[0].receipt;
      } finally {
        await db.exec('RESET ROLE');
      }
    };
    const denied = async (sql) => {
      let error;
      try { await db.exec(sql); } catch (caught) { error = caught; }
      assert.equal(error?.code, '42501', 'Expected insufficient_privilege for: ' + sql);
    };
    const applyAs = async (role) => {
      await db.exec('SET ROLE ' + role);
      try { await db.exec(migration); }
      finally { await db.exec('ROLLBACK; RESET ROLE'); }
    };
    await db.exec(\`
      CREATE ROLE installer LOGIN CREATEROLE CREATEDB;
      CREATE ROLE auth_admin NOLOGIN;
      CREATE ROLE apps_migration_coordinator NOLOGIN NOINHERIT;
      CREATE ROLE service_role NOLOGIN;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      GRANT apps_migration_coordinator TO installer WITH INHERIT FALSE, SET TRUE;
      GRANT USAGE, CREATE ON SCHEMA public TO installer, apps_migration_coordinator;
      GRANT USAGE ON SCHEMA public TO service_role;
      DO $grant$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO installer', current_database()); END $grant$;
      CREATE TABLE public.apps_tenants (
        tenant_id uuid PRIMARY KEY, requirement_id uuid NOT NULL UNIQUE,
        user_id uuid NOT NULL, site_id uuid NOT NULL, schema text NOT NULL,
        bucket text NOT NULL, auth_provider text NOT NULL, status text NOT NULL
      );
      ALTER TABLE public.apps_tenants OWNER TO installer;
      CREATE SCHEMA auth AUTHORIZATION auth_admin;
      REVOKE ALL ON SCHEMA auth FROM PUBLIC;
      CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
      ALTER TABLE auth.users OWNER TO auth_admin;
      INSERT INTO auth.users VALUES ('\${user}', 'private@example.com');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
        AS 'SELECT NULLIF(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
        AS 'SELECT NULLIF(current_setting(''request.jwt.claims'', true), '''')::jsonb';
      CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE
        AS 'SELECT NULLIF(current_setting(''request.jwt.claim.email'', true), '''')';
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
        AS 'SELECT NULLIF(current_setting(''request.jwt.claim.role'', true), '''')';
      CREATE FUNCTION auth.uid(text) RETURNS text LANGUAGE sql AS 'SELECT $1';
      CREATE FUNCTION auth.internal_secret() RETURNS text LANGUAGE sql AS 'SELECT ''secret''::text';
      ALTER FUNCTION auth.uid() OWNER TO auth_admin;
      ALTER FUNCTION auth.jwt() OWNER TO auth_admin;
      ALTER FUNCTION auth.email() OWNER TO auth_admin;
      ALTER FUNCTION auth.role() OWNER TO auth_admin;
      ALTER FUNCTION auth.uid(text) OWNER TO auth_admin;
      ALTER FUNCTION auth.internal_secret() OWNER TO auth_admin;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC;
      GRANT USAGE ON SCHEMA auth TO installer, authenticated;
      GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt(), auth.email(), auth.role() TO authenticated;
    \`);
    await db.exec(previousMigration);
    await db.exec('ALTER FUNCTION public.apps_ensure_tenant(uuid,uuid,uuid,uuid,text) OWNER TO installer');
    const initial = await ensure();
    assert.equal(initial.created, true);
    const authorize = async () => db.exec(\`
      SET ROLE auth_admin;
      GRANT USAGE ON SCHEMA auth TO installer WITH GRANT OPTION;
      GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt(), auth.email(), auth.role() TO installer WITH GRANT OPTION;
      RESET ROLE;
    \`);
    ${check}
    await db.close();
    console.log('ok');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.slice(-6_000) || 'Offline PGlite auth helper check failed');
  }
  expect(result.stdout.trim()).toBe('ok');
}

describe('Apps constrained tenant auth helper ACL repair', () => {
  it('preserves the prior provisioning body except for the isolated helper grants', () => {
    const start = 'CREATE OR REPLACE FUNCTION public.apps_ensure_tenant(';
    const oldFunction = previousMigration.slice(previousMigration.indexOf(start)).trim();
    const newFunction = forwardMigration.slice(forwardMigration.indexOf(start))
      .replace(/\n  auth_helper_name text;\n  auth_helper_oid oid;/, '')
      .replace(/\n\n  -- Claim helpers only:[\s\S]*?(?=\n  -- Ownership changes require)/, '')
      .replace(/\nCOMMIT;\s*$/, '').trim();
    expect(newFunction).toBe(oldFunction);
    expect(forwardMigration).not.toMatch(/GRANT[^;]*ALL[^;]*SCHEMA auth/i);
    expect(forwardMigration).not.toMatch(/GRANT[^;]*(?:ON TABLE auth|CREATE ON SCHEMA auth|service_role TO|authenticated TO)/i);
  });

  it('repairs policy creation without auth data/DDL, other helpers, or cross-tenant access; provisions and retries safely', () => {
    runPGlite(`
      const ledgerBefore = await db.query('SELECT * FROM ' + schema + '._meta ORDER BY key');
      await db.exec('SET ROLE ' + owner);
      await db.exec('CREATE TABLE ' + schema + '.profiles (user_id uuid PRIMARY KEY, name text); ALTER TABLE ' + schema + '.profiles ENABLE ROW LEVEL SECURITY');
      const policy = 'CREATE POLICY self_only ON ' + schema + '.profiles TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())';
      await denied(policy);
      await db.exec('RESET ROLE');

      // Lookalike and orphan owner roles, plus a registry/schema-owner mismatch,
      // must not be granted access by a broad prefix scan.
      await db.exec(\`
        CREATE ROLE app_owner_aaaaaaaaaaaaaaaaaaaaaaaa NOLOGIN NOINHERIT;
        CREATE ROLE app_owner_bbbbbbbbbbbbbbbbbbbbbbbb NOLOGIN NOINHERIT;
        CREATE SCHEMA app_aaaaaaaaaaaaaaaaaaaaaaaa AUTHORIZATION app_owner_aaaaaaaaaaaaaaaaaaaaaaaa;
        CREATE SCHEMA app_bbbbbbbbbbbbbbbbbbbbbbbb;
        INSERT INTO public.apps_tenants VALUES (
          '00000000-0000-4000-8000-000000000010', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          '\${user}', '\${args[3]}', 'app_bbbbbbbbbbbbbbbbbbbbbbbb', 'tenant-b', 'supabase', 'active'
        );
      \`);
      await authorize();
      await applyAs('installer');
      // Reapplication is safe and still does not touch any ledger.
      await applyAs('installer');
      assert.deepEqual(await db.query('SELECT * FROM ' + schema + '._meta ORDER BY key'), ledgerBefore);

      await db.exec('SET ROLE ' + owner);
      await db.exec(policy);
      await db.exec(\`SELECT set_config('request.jwt.claim.sub', '\${user}', false),
        set_config('request.jwt.claim.email', 'self@example.com', false),
        set_config('request.jwt.claim.role', 'authenticated', false),
        set_config('request.jwt.claims', '{"sub":"\${user}"}', false)\`);
      const claims = (await db.query('SELECT auth.uid() AS id, auth.jwt() AS jwt, auth.email() AS email, auth.role() AS role')).rows[0];
      assert.deepEqual(claims, { id: user, jwt: { sub: user }, email: 'self@example.com', role: 'authenticated' });
      for (const sql of [
        'SELECT * FROM auth.users',
        "INSERT INTO auth.users VALUES ('00000000-0000-4000-8000-000000000099', 'bad')",
        "UPDATE auth.users SET email = 'bad'",
        'DELETE FROM auth.users',
        'CREATE TABLE auth.forbidden (id int)',
        'SELECT auth.internal_secret()',
        "SELECT auth.uid('overload')",
        'CREATE TABLE app_aaaaaaaaaaaaaaaaaaaaaaaa.forbidden (id int)',
        'SELECT * FROM ' + schema + '._meta',
      ]) await denied(sql);
      await db.exec('RESET ROLE');
      // Runtime RLS remains effective for the shared API role.
      await db.exec('SET ROLE authenticated');
      await db.exec("INSERT INTO " + schema + ".profiles VALUES ('" + user + "', 'self')");
      await denied("INSERT INTO " + schema + ".profiles VALUES ('00000000-0000-4000-8000-000000000099', 'other')");
      assert.equal((await db.query('SELECT * FROM ' + schema + '.profiles')).rows.length, 1);
      await db.exec("SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', false)");
      assert.equal((await db.query('SELECT * FROM ' + schema + '.profiles')).rows.length, 0);
      await db.exec('RESET ROLE');

      const newArgs = ['22222222-2222-4333-8444-555555555555',
        '00000000-0000-4000-8000-000000000020', ...args.slice(2)];
      const fresh = await ensure(newArgs);
      assert.equal(fresh.created, true);
      const freshOwner = 'app_owner_222222222222433384445555';
      const ledger = await db.query('SELECT * FROM ' + fresh.schema + '._meta ORDER BY key');
      for (let i = 0; i < 2; i++) {
        const receipt = await ensure([newArgs[0], '00000000-0000-4000-8000-000000000099', ...args.slice(2)]);
        assert.deepEqual(receipt, { ...fresh, created: false });
      }
      assert.deepEqual(await db.query('SELECT * FROM ' + fresh.schema + '._meta ORDER BY key'), ledger);
      const attrs = (await db.query(\`SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb,
        rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = '\${freshOwner}'\`)).rows[0];
      assert.ok(Object.values(attrs).every(value => value === false));
      const memberships = (await db.query(\`SELECT count(*)::int AS count FROM pg_auth_members
        WHERE member = '\${freshOwner}'::regrole\`)).rows[0];
      assert.equal(memberships.count, 0);
      for (const role of [owner, freshOwner]) {
        const acl = (await db.query(\`SELECT
          has_schema_privilege('\${role}', 'auth', 'USAGE') AS usage,
          has_schema_privilege('\${role}', 'auth', 'CREATE') AS create,
          has_schema_privilege('\${role}', 'auth', 'USAGE WITH GRANT OPTION') AS grant_option,
          has_function_privilege('\${role}', 'auth.uid()', 'EXECUTE') AS uid,
          has_function_privilege('\${role}', 'auth.jwt()', 'EXECUTE') AS jwt,
          has_function_privilege('\${role}', 'auth.email()', 'EXECUTE') AS email,
          has_function_privilege('\${role}', 'auth.role()', 'EXECUTE') AS role,
          has_table_privilege('\${role}', 'auth.users', 'SELECT,INSERT,UPDATE,DELETE') AS users\`)).rows[0];
        assert.deepEqual(acl, { usage: true, create: false, grant_option: false,
          uid: true, jwt: true, email: true, role: true, users: false });
      }
      await db.exec('SET ROLE ' + freshOwner);
      await db.exec('CREATE TABLE ' + fresh.schema + '.profiles (user_id uuid); CREATE POLICY self_only ON ' + fresh.schema + '.profiles USING (user_id = auth.uid())');
      await denied('SELECT * FROM ' + schema + '.profiles');
      await denied('CREATE TABLE ' + schema + '.forbidden (id int)');
      await db.exec('RESET ROLE');
      for (const role of ['app_owner_aaaaaaaaaaaaaaaaaaaaaaaa', 'app_owner_bbbbbbbbbbbbbbbbbbbbbbbb']) {
        assert.equal((await db.query(\`SELECT has_schema_privilege('\${role}', 'auth', 'USAGE') AS allowed\`)).rows[0].allowed, false);
      }
      assert.equal((await db.query(\`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class
        WHERE oid = '\${fresh.schema}._meta'::regclass\`)).rows[0].owner, 'apps_migration_coordinator');
      assert.equal((await db.query(\`SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
        WHERE oid = 'public.apps_ensure_tenant(uuid,uuid,uuid,uuid,text)'::regprocedure\`)).rows[0].owner, 'installer');
      // SET ROLE checks session_user, not current_user; demote the session too.
      await db.exec('SET SESSION AUTHORIZATION ' + owner);
      await denied('SET ROLE service_role');
      await denied('SET ROLE authenticated');
    `);
  }, 35_000);

  it('fails atomically for missing installer or retained definer grant authority and checks later revoked grants', () => {
    runPGlite(`
      const definitionBefore = (await db.query("SELECT pg_get_functiondef('public.apps_ensure_tenant(uuid,uuid,uuid,uuid,text)'::regprocedure) AS definition")).rows[0].definition;
      // This is the hosted managed-postgres failure mode: GRANT warns/no-ops.
      await db.exec('SET ROLE installer');
      await db.exec('GRANT USAGE ON SCHEMA auth TO ' + owner);
      assert.equal((await db.query(\`SELECT has_schema_privilege('\${owner}', 'auth', 'USAGE') AS allowed\`)).rows[0].allowed, false);
      await db.exec('RESET ROLE');
      for (const role of ['installer', 'postgres']) {
        await assert.rejects(applyAs(role), error => error.code === '42501' && /operator-authorized/.test(error.message));
        assert.equal((await db.query(\`SELECT has_schema_privilege('\${owner}', 'auth', 'USAGE') AS allowed\`)).rows[0].allowed, false);
        assert.equal((await db.query("SELECT pg_get_functiondef('public.apps_ensure_tenant(uuid,uuid,uuid,uuid,text)'::regprocedure) AS definition")).rows[0].definition, definitionBefore);
      }
      await db.exec('SET ROLE auth_admin; GRANT USAGE ON SCHEMA auth TO installer WITH GRANT OPTION; RESET ROLE');
      await assert.rejects(applyAs('installer'), error => error.code === '42501' && /EXECUTE grant authority/.test(error.message));
      await authorize();
      await applyAs('installer');

      // Authority can be revoked later. New-tenant postchecks must abort the
      // complete registry/role/schema transaction rather than accept warnings.
      await db.exec('SET ROLE auth_admin; REVOKE GRANT OPTION FOR USAGE ON SCHEMA auth FROM installer CASCADE; RESET ROLE');
      const failedArgs = ['33333333-2222-4333-8444-555555555555',
        '00000000-0000-4000-8000-000000000030', ...args.slice(2)];
      await assert.rejects(ensure(failedArgs), error => error.code === '42501' && /USAGE grant failed/.test(error.message));
      assert.equal((await db.query(\`SELECT count(*)::int AS count FROM public.apps_tenants WHERE requirement_id = '\${failedArgs[0]}'\`)).rows[0].count, 0);
      assert.equal((await db.query("SELECT to_regrole('app_owner_333333332222433384445555') AS role")).rows[0].role, null);
      await authorize();
      await db.exec('SET ROLE auth_admin; REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION auth.uid() FROM installer CASCADE; RESET ROLE');
      await assert.rejects(ensure(failedArgs), error => error.code === '42501' && /EXECUTE grant failed/.test(error.message));
      assert.equal((await db.query("SELECT to_regnamespace('app_333333332222433384445555') AS schema")).rows[0].schema, null);
    `);
  }, 35_000);

  it('skips absent optional helpers and rejects unsafe existing role attributes or memberships', () => {
    runPGlite(`
      await authorize();
      await db.exec('DROP FUNCTION auth.email(); DROP FUNCTION auth.role()');
      for (const attribute of ['LOGIN', 'INHERIT', 'CREATEDB', 'CREATEROLE', 'SUPERUSER', 'REPLICATION', 'BYPASSRLS']) {
        await db.exec('ALTER ROLE ' + owner + ' ' + attribute);
        await assert.rejects(applyAs('installer'), /not isolated; auth helper grants refused/);
        assert.equal((await db.query(\`SELECT has_schema_privilege('\${owner}', 'auth', 'USAGE') AS allowed\`)).rows[0].allowed, attribute === 'SUPERUSER');
        await db.exec('ALTER ROLE ' + owner + ' NO' + attribute);
      }
      await db.exec('GRANT authenticated TO ' + owner);
      await assert.rejects(applyAs('installer'), /not isolated; auth helper grants refused/);
      await db.exec('REVOKE authenticated FROM ' + owner);
      await applyAs('installer');
      assert.equal((await db.query(\`SELECT has_function_privilege('\${owner}', 'auth.uid()', 'EXECUTE') AS allowed\`)).rows[0].allowed, true);
      const newArgs = ['44444444-2222-4333-8444-555555555555',
        '00000000-0000-4000-8000-000000000040', ...args.slice(2)];
      assert.equal((await ensure(newArgs)).created, true);
    `);
  }, 35_000);

  it('backfills all 178 registered constrained owners without a hardcoded tenant list', () => {
    runPGlite(`
      await db.exec(\`
        DO $seed$
        DECLARE suffix text; role_name text;
        BEGIN
          FOR i IN 1..177 LOOP
            suffix := left(md5('auth-helper-backfill:' || i::text), 24);
            role_name := 'app_owner_' || suffix;
            EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE', role_name);
            EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I', 'app_' || suffix, role_name);
            INSERT INTO public.apps_tenants VALUES (
              md5('tenant:' || i::text)::uuid, md5('requirement:' || i::text)::uuid,
              '\${user}', '\${args[3]}', 'app_' || suffix, 'tenant-' || suffix, 'supabase', 'active'
            );
          END LOOP;
        END $seed$;
      \`);
      const grantedCount = async () => (await db.query(\`SELECT count(*)::int AS count
        FROM public.apps_tenants t
        JOIN pg_namespace n ON n.nspname = t.schema
        JOIN pg_roles r ON r.oid = n.nspowner
        WHERE has_schema_privilege(r.oid, 'auth', 'USAGE')
          AND has_function_privilege(r.oid, 'auth.uid()', 'EXECUTE')
          AND has_function_privilege(r.oid, 'auth.jwt()', 'EXECUTE')\`)).rows[0].count;
      assert.equal(await grantedCount(), 0);
      await authorize();
      await applyAs('installer');
      assert.equal(await grantedCount(), 178);
      await applyAs('installer');
      assert.equal(await grantedCount(), 178);
    `);
  }, 35_000);
});