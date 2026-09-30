import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260930020000_apps_tenant_storage.sql'),
  'utf8',
);

// Execute actual PostgreSQL RLS in a separate process, like the reprovision SQL
// tests. The fixture gateway signs/verifies offline HS256 tokens before setting
// request.jwt.claims; PGlite itself (like PostgreSQL) does not verify JWTs. No
// remote project, operational signing secret or Storage API is involved.
const fixture = String.raw`
  import assert from 'node:assert/strict';
  import { createHmac, timingSafeEqual } from 'node:crypto';
  import { PGlite } from '@electric-sql/pglite';
  const db = new PGlite();
  const owner = '00000000-0000-4000-8000-000000000001';
  const alice = '00000000-0000-4000-8000-000000000002';
  const bob = '00000000-0000-4000-8000-000000000003';
  const stranger = '00000000-0000-4000-8000-000000000004';
  const site = '00000000-0000-4000-8000-000000000005';
  const a = {
    tenant: '10000000-0000-4000-8000-000000000001',
    requirement: '20000000-0000-4000-8000-000000000001',
    schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', bucket: 'tenant-aaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const b = {
    tenant: '10000000-0000-4000-8000-000000000002',
    requirement: '20000000-0000-4000-8000-000000000002',
    schema: 'app_bbbbbbbbbbbbbbbbbbbbbbbb', bucket: 'tenant-bbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const backend = (tenant = a) => ({
    role: 'authenticated', sub: owner, tenant_id: tenant.tenant, schema: tenant.schema,
  });
  const user = (sub = alice, extra = {}) => ({ role: 'authenticated', sub, ...extra });
  const privatePath = (sub = alice, name = 'seed.txt') => 'users/' + sub + '/' + name;
  const key = 'offline-storage-authorization-fixture-key-not-a-project-secret';
  const mac = value => createHmac('sha256', key).update(value).digest();
  function sign(claims) {
    const data = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url') + '.'
      + Buffer.from(JSON.stringify(claims)).toString('base64url');
    return data + '.' + mac(data).toString('base64url');
  }
  function verify(token) {
    const parts = token.split('.');
    assert.equal(parts.length, 3);
    assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url')), { alg: 'HS256', typ: 'JWT' });
    const signature = Buffer.from(parts[2], 'base64url');
    const expected = mac(parts[0] + '.' + parts[1]);
    assert.equal(signature.length, expected.length);
    assert.ok(timingSafeEqual(signature, expected), 'fixture gateway rejects unsigned/tampered claims');
    return JSON.parse(Buffer.from(parts[1], 'base64url'));
  }
  async function rawRole(role, claims, callback) {
    assert.ok(['authenticated', 'anon', 'service_role'].includes(role));
    await db.query("SELECT set_config('request.jwt.claims', $1, false)", [claims]);
    await db.exec('SET ROLE ' + role);
    try { return await callback(); }
    finally {
      try {
        await db.exec('RESET ROLE');
        await db.exec("SELECT set_config('request.jwt.claims', '', false)");
      } catch (error) {
        // Tamper cases use an outer transaction which their caller rolls back.
        if (error.code !== '25P02') throw error;
      }
    }
  }
  const asRole = (role, claims, callback) => rawRole(role,
    claims === null ? '' : JSON.stringify(verify(sign(claims))), callback);
  const request = (claims, callback) => asRole('authenticated', claims, callback);
  const helper = async (bucket, name, sub) => (await db.query(
    'SELECT public.apps_storage_object_allowed($1,$2,$3) AS allowed', [bucket, name, sub]
  )).rows[0].allowed;
  const visible = async (bucket = a.bucket) => (await db.query(
    'SELECT name, owner_id FROM storage.objects WHERE bucket_id = $1 ORDER BY name', [bucket]
  )).rows;
  const insert = (bucket, name, sub) => db.query(
    'INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES ($1,$2,$3) RETURNING name',
    [bucket, name, sub]
  );
  const config = (requirement = a.requirement, tenant = a.tenant) => asRole(
    'service_role', { role: 'service_role' }, async () => (await db.query(
      'SELECT public.apps_get_tenant_storage_config($1,$2) AS config', [requirement, tenant]
    )).rows[0].config
  );
  const denied = async action => assert.rejects(action, error => {
    assert.equal(error.code, '42501', error.message);
    return true;
  });
  async function install() {
    await db.exec('SET ROLE installer');
    try { await db.exec(migration); }
    finally { await db.exec('ROLLBACK; RESET ROLE'); }
  }
  await db.exec(
    "CREATE ROLE installer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;"
    + "CREATE ROLE supabase_storage_admin NOLOGIN; CREATE ROLE anon NOLOGIN;"
    + "CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;"
    + "CREATE SCHEMA storage; CREATE SCHEMA auth;"
    + "REVOKE ALL ON SCHEMA auth FROM PUBLIC;"
    + "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';"
    + "CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog"
    + " AS $$SELECT NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'role'$$;"
    + "REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;"
    + "GRANT USAGE, CREATE ON SCHEMA public TO installer;"
    + "GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;"
    + "GRANT USAGE ON SCHEMA storage TO installer, authenticated, anon, service_role, supabase_storage_admin;"
    + "CREATE TABLE public.apps_tenants(tenant_id uuid PRIMARY KEY, requirement_id uuid NOT NULL UNIQUE,"
    + "user_id uuid NOT NULL, site_id uuid NOT NULL, schema text NOT NULL, bucket text NOT NULL,"
    + "status text NOT NULL, limits jsonb DEFAULT '{\"max_storage_mb\":500}');"
    + "CREATE TABLE public.tenant_users(tenant_id uuid REFERENCES public.apps_tenants,"
    + "user_id uuid NOT NULL, role text NOT NULL, PRIMARY KEY(tenant_id,user_id));"
    + "ALTER TABLE public.apps_tenants OWNER TO installer;"
    + "ALTER TABLE public.tenant_users OWNER TO installer;"
    + "ALTER TABLE public.apps_tenants ENABLE ROW LEVEL SECURITY;"
    + "ALTER TABLE public.tenant_users ENABLE ROW LEVEL SECURITY;"
    + "CREATE TABLE storage.buckets(id text PRIMARY KEY, public boolean NOT NULL DEFAULT false);"
    + "CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,"
    + "bucket_id text REFERENCES storage.buckets, name text NOT NULL, owner_id text, metadata jsonb,"
    + "UNIQUE(bucket_id,name));"
    + "ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;"
    + "ALTER TABLE storage.objects OWNER TO installer;"
    + "ALTER TABLE storage.buckets OWNER TO supabase_storage_admin;"
    + "GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated, anon, service_role;"
    + "CREATE POLICY \"workspaces service only\" ON storage.objects FOR ALL TO PUBLIC"
    + " USING (bucket_id = 'workspaces' AND auth.role() = 'service_role')"
    + " WITH CHECK (bucket_id = 'workspaces' AND auth.role() = 'service_role');"
    + "CREATE SCHEMA unrelated_workspace;"
    + "CREATE TABLE unrelated_workspace.documents(id integer, payload text);"
    + "INSERT INTO unrelated_workspace.documents VALUES (1,'must remain unchanged');"
  );
  for (const tenant of [a, b]) {
    await db.query('INSERT INTO public.apps_tenants(tenant_id,requirement_id,user_id,site_id,schema,bucket,status)'
      + " VALUES ($1,$2,$3,$4,$5,$6,'active')", [tenant.tenant, tenant.requirement, owner, site, tenant.schema, tenant.bucket]);
    await db.query('INSERT INTO storage.buckets(id) VALUES ($1)', [tenant.bucket]);
    await insert(tenant.bucket, 'backend/seed.txt', owner);
  }
  await db.query('INSERT INTO public.tenant_users VALUES ($1,$2,$3),($1,$4,$5),($6,$7,$3)',
    [a.tenant, alice, 'member', owner, 'owner', b.tenant, bob]);
  await insert(a.bucket, privatePath(), alice);
  await insert(a.bucket, privatePath(owner, 'private.txt'), owner);
  await insert(b.bucket, privatePath(bob), bob);
  await db.exec("INSERT INTO storage.buckets(id) VALUES ('workspaces')");
  await insert('workspaces', 'logo.png', stranger);
`;

function runOffline(body: string) {
  const script = `const migration = ${JSON.stringify(migration)};\n${fixture}\n${body}\nawait db.close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.slice(-8_000) || result.error?.message || 'PGlite Storage check failed');
  }
}

describe('Apps tenant Storage SQL authorization', () => {
  it('executes real backend and personal INSERT/SELECT/UPDATE/DELETE, with both UPDATE boundaries', () => {
    runOffline(String.raw`
      await install();
      await request(backend(), async () => {
        assert.deepEqual((await visible()).map(row => row.name), ['backend/seed.txt']);
        assert.deepEqual(await visible(b.bucket), [], 'same sub cannot use another tenant bucket');
        assert.equal(await helper(a.bucket, privatePath(owner, 'private.txt'), owner), false);
        await denied(() => insert(a.bucket, privatePath(owner, 'backend-stole.txt'), owner));
        assert.equal((await insert(a.bucket, 'backend/nested/new.txt', owner)).rows.length, 1);
        assert.equal((await db.query('UPDATE storage.objects SET name=$1 WHERE bucket_id=$2 AND name=$3 RETURNING name',
          ['backend/nested/renamed.txt', a.bucket, 'backend/nested/new.txt'])).rows.length, 1);
        await denied(() => db.query('UPDATE storage.objects SET bucket_id=$1 WHERE bucket_id=$2', [b.bucket, a.bucket]));
        await denied(() => db.query('UPDATE storage.objects SET name=$1 WHERE bucket_id=$2', [privatePath(owner, 'stolen.txt'), a.bucket]));
        await denied(() => db.query('UPDATE storage.objects SET owner_id=$1 WHERE bucket_id=$2', [alice, a.bucket]));
        assert.equal((await db.query('UPDATE storage.objects SET name=$1 WHERE bucket_id=$2 AND name=$3 RETURNING name',
          ['backend/stolen.txt', a.bucket, privatePath()])).rows.length, 0, 'UPDATE USING protects old private row');
        assert.equal((await db.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2 RETURNING name',
          [a.bucket, privatePath()])).rows.length, 0);
        assert.equal((await db.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2 RETURNING name',
          [a.bucket, 'backend/nested/renamed.txt'])).rows.length, 1);
      });
      await request(user(), async () => {
        assert.deepEqual((await visible()).map(row => row.name), [privatePath()]);
        assert.equal((await insert(a.bucket, privatePath(alice, 'new.txt'), alice)).rows.length, 1);
        assert.equal((await db.query('UPDATE storage.objects SET name=$1 WHERE bucket_id=$2 AND name=$3 RETURNING name',
          [privatePath(alice, 'renamed.txt'), a.bucket, privatePath(alice, 'new.txt')])).rows.length, 1);
        await denied(() => insert(a.bucket, 'backend/member.txt', alice));
        await denied(() => insert(a.bucket, privatePath(owner, 'member.txt'), alice));
        await denied(() => insert(a.bucket, privatePath(alice, 'bad-owner.txt'), owner));
        await denied(() => db.query('UPDATE storage.objects SET bucket_id=$1 WHERE bucket_id=$2', [b.bucket, a.bucket]));
        await denied(() => db.query('UPDATE storage.objects SET name=$1 WHERE bucket_id=$2', ['backend/promoted.txt', a.bucket]));
        await denied(() => db.query('UPDATE storage.objects SET owner_id=$1 WHERE bucket_id=$2', [owner, a.bucket]));
        await denied(() => db.query('UPDATE storage.objects SET name=$1, owner_id=$2 WHERE bucket_id=$3',
          [privatePath(owner, 'renamed.txt'), owner, a.bucket]));
        assert.equal((await db.query('UPDATE storage.objects SET name=$1,owner_id=$2 WHERE bucket_id=$3 AND name=$4 RETURNING name',
          [privatePath(alice, 'stolen.txt'), alice, a.bucket, 'backend/seed.txt'])).rows.length, 0);
        assert.equal((await db.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2 RETURNING name',
          [a.bucket, 'backend/seed.txt'])).rows.length, 0);
        assert.equal((await db.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2 RETURNING name',
          [a.bucket, privatePath(alice, 'renamed.txt')])).rows.length, 1);
      });
      await request(backend(b), async () => {
        assert.deepEqual((await visible(b.bucket)).map(row => row.name), ['backend/seed.txt']);
        assert.deepEqual(await visible(), []);
      });
      await request(user(bob), async () => {
        assert.deepEqual((await visible(b.bucket)).map(row => row.name), [privatePath(bob)]);
        assert.deepEqual(await visible(), []);
      });
      // A conflicting signed payload cannot reach the database through the gateway.
      const token = sign(backend());
      const parts = token.split('.');
      parts[1] = Buffer.from(JSON.stringify(backend(b))).toString('base64url');
      assert.throws(() => verify(parts.join('.')));
    `);
  }, 35_000);

  it('fails closed for malformed identities, scoped claims, metadata spoofing and non-normalized paths', () => {
    runOffline(String.raw`
      await install();
      for (const raw of ['', '{', 'null', '[]', '42', '"authenticated"']) {
        await rawRole('authenticated', raw, async () => {
          assert.equal(await helper(a.bucket, 'backend/a.txt', owner), false);
          assert.deepEqual(await visible(), []);
          await denied(() => insert(a.bucket, 'backend/invalid.txt', owner));
        });
      }
      for (const claims of [
        {}, { role:'authenticated' }, user(null), user('not-a-uuid'), user(''), user(42), user({}),
        { ...backend(), role:'service_role' }, { ...backend(), role:'anon' },
        { ...backend(), role:null }, { ...backend(), tenant_id:b.tenant },
        { ...backend(), schema:b.schema }, { ...backend(), tenant_id:null },
        { ...backend(), schema:null }, { ...backend(), sub:stranger },
        user(owner, { tenant_id:a.tenant }), user(owner, { schema:a.schema }),
      ]) {
        await request(claims, async () => {
          assert.equal(await helper(a.bucket, 'backend/no.txt', owner), false, JSON.stringify(claims));
          assert.deepEqual(await visible(), []);
          await denied(() => insert(a.bucket, 'backend/no.txt', owner));
        });
      }
      // Server GUC precedence is explicit: no fallback to a stray legacy sub/role.
      await db.exec("SELECT set_config('request.jwt.claim.sub','" + owner + "',false),"
        + "set_config('request.jwt.claim.role','authenticated',false)");
      await request(null, async () => assert.equal(await helper(a.bucket, 'backend/no.txt', owner), false));
      await request(user(alice), async () => assert.equal(await helper(a.bucket, 'backend/no.txt', owner), false));
      for (const claims of [
        user(alice, {tenant_id:b.tenant}), user(alice, {schema:b.schema}),
        user(alice, {tenant_id:null}), user(alice, {schema:42}),
        user(stranger, { user_metadata:{tenant_id:a.tenant, schema:a.schema, role:'owner', sub:alice},
          app_metadata:{tenant_id:a.tenant, role:'owner'} }),
        user(owner, { user_metadata:{tenant_id:a.tenant, schema:a.schema} }),
      ]) {
        await request(claims, async () => {
          assert.equal(await helper(a.bucket, privatePath(), alice), false);
          assert.equal(await helper(a.bucket, 'backend/spoof.txt', owner), false);
          await denied(() => insert(a.bucket, privatePath(alice, 'spoof.txt'), alice));
        });
      }
      // Matching optional signed claims constrain ordinary users, not metadata.
      for (const claims of [user(), user(alice,{tenant_id:a.tenant}), user(alice,{schema:a.schema}),
        user(alice,{tenant_id:a.tenant,schema:a.schema}),
        user(alice,{user_metadata:{tenant_id:b.tenant,sub:owner}})]) {
        await request(claims, async () => assert.equal(await helper(a.bucket, privatePath(), alice), true));
      }
      // Owner's unscoped personal JWT works only because a membership exists.
      await request(user(owner), async () => {
        assert.equal(await helper(a.bucket, privatePath(owner), owner), true);
        assert.equal(await helper(a.bucket, 'backend/not-backend.txt', owner), false);
      });
      const invalid = [null, '', ' ', 'backend', 'backend/', '/backend/x', 'backend//x',
        'backend/./x', 'backend/../x', 'backend/x/..', 'backend/x/.', 'backend/x/',
        'backend/ /x', 'backend/x\\y', 'backend\\x', 'other/x', 'backendish/x',
        privatePath(owner), privatePath(alice)];
      await request(backend(), async () => {
        for (const name of invalid) assert.equal(await helper(a.bucket, name, owner), false, String(name));
        for (const name of invalid.filter(name => name !== null)) {
          await denied(() => insert(a.bucket, name, owner));
        }
        for (const bucket of [null, '', 'tenant-A'.padEnd(31,'a'), 'tenant-short', a.bucket+'x', 'workspaces']) {
          assert.equal(await helper(bucket, 'backend/ok.txt', owner), false);
        }
        assert.equal(await helper(a.bucket, 'backend/ok.txt', null), false);
        assert.equal(await helper(a.bucket, 'backend/ok.txt', alice), false);
        assert.equal(await helper(a.bucket, 'backend/nested/ok.txt', owner), true);
      });
      await request(user(), async () => {
        for (const name of ['users', 'users/'+alice, 'users/'+alice+'/', privatePath(alice,'../x'),
          privatePath(alice,'./x'), privatePath(alice,'a//b'), privatePath(alice,'a\\b'), privatePath(bob)]) {
          assert.equal(await helper(a.bucket, name, alice), false, name);
          await denied(() => insert(a.bucket, name, alice));
        }
      });
    `);
  }, 35_000);

  it('honors membership revocation, supported roles and active unambiguous registry bindings', () => {
    runOffline(String.raw`
      await install();
      for (const role of ['member', 'editor', 'admin', 'owner']) {
        await db.query('UPDATE public.tenant_users SET role=$1 WHERE tenant_id=$2 AND user_id=$3', [role, a.tenant, alice]);
        await request(user(), async () => assert.equal(await helper(a.bucket, privatePath(), alice), true, role));
      }
      await db.query("UPDATE public.tenant_users SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [a.tenant, alice]);
      await request(user(), async () => {
        assert.equal(await helper(a.bucket, privatePath(), alice), false);
        assert.deepEqual(await visible(), []);
      });
      await db.query('DELETE FROM public.tenant_users WHERE tenant_id=$1 AND user_id=$2', [a.tenant, alice]);
      await request(user(), async () => {
        assert.deepEqual(await visible(), []);
        await denied(() => insert(a.bucket, privatePath(alice, 'revoked.txt'), alice));
        assert.equal((await db.query('UPDATE storage.objects SET name=$1 WHERE bucket_id=$2 RETURNING name',
          [privatePath(alice,'revoked.txt'), a.bucket])).rows.length, 0);
        assert.equal((await db.query('DELETE FROM storage.objects WHERE bucket_id=$1 RETURNING name', [a.bucket])).rows.length, 0);
      });
      await db.query('DELETE FROM public.tenant_users WHERE tenant_id=$1 AND user_id=$2', [a.tenant, owner]);
      await request(user(owner), async () => assert.equal(await helper(a.bucket, privatePath(owner), owner), false));
      await request(backend(), async () => assert.equal(await helper(a.bucket, 'backend/ok.txt', owner), true));
      // Backend needs registry binding, never implicit user membership.
      for (const status of ['suspended', 'destroyed']) {
        await db.query('UPDATE public.apps_tenants SET status=$1 WHERE tenant_id=$2', [status, a.tenant]);
        await request(backend(), async () => {
          assert.equal(await helper(a.bucket, 'backend/ok.txt', owner), false);
          assert.deepEqual(await visible(), []);
          await denied(() => insert(a.bucket, 'backend/inactive.txt', owner));
        });
        await assert.rejects(() => config(), /registry binding is not active and valid/);
      }
      await db.query("UPDATE public.apps_tenants SET status='active' WHERE tenant_id=$1", [a.tenant]);
      for (const schema of [b.schema, 'app_not-valid']) {
        await db.query('UPDATE public.apps_tenants SET schema=$1 WHERE tenant_id=$2', [schema, a.tenant]);
        await request(backend(), async () => assert.equal(await helper(a.bucket, 'backend/ok.txt', owner), false));
        await assert.rejects(() => config(), /registry binding is not active and valid/);
      }
      await db.query('UPDATE public.apps_tenants SET schema=$1 WHERE tenant_id=$2', [a.schema, a.tenant]);
      await db.query("UPDATE public.apps_tenants SET bucket=$1,status='suspended' WHERE tenant_id=$2", [a.bucket, b.tenant]);
      await request(backend(), async () => {
        assert.equal(await helper(a.bucket, 'backend/ok.txt', owner), false, 'even inactive duplicate is ambiguous');
        assert.deepEqual(await visible(), []);
      });
      await assert.rejects(() => config(), /registry binding is not active and valid/);
      await db.query("UPDATE public.apps_tenants SET bucket=$1,status='active' WHERE tenant_id=$2", [b.bucket, b.tenant]);
      await db.query('UPDATE public.apps_tenants SET user_id=$1 WHERE tenant_id=$2', [stranger, a.tenant]);
      await request(backend(), async () => {
        assert.equal(await helper(a.bucket, 'backend/ok.txt', owner), false);
        assert.deepEqual(await visible(), []);
      });
      await assert.rejects(() => config(b.requirement, a.tenant), /registry binding/);
      await assert.rejects(() => config(null, a.tenant), /Invalid Apps Storage configuration request/);
      await assert.rejects(() => config(a.requirement, null), /Invalid Apps Storage configuration request/);
    `);
  }, 35_000);

  it('provides only the read-only service config before bucket creation, and leaves data/ACLs unchanged on reapply', () => {
    runOffline(String.raw`
      async function snapshot() {
        return {
          tenants: (await db.query('TABLE public.apps_tenants')).rows,
          memberships: (await db.query('TABLE public.tenant_users')).rows,
          roleMemberships: (await db.query('TABLE pg_auth_members')).rows,
          roles: (await db.query('SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles ORDER BY oid')).rows,
          objects: (await db.query('SELECT * FROM storage.objects ORDER BY id')).rows,
          buckets: (await db.query('TABLE storage.buckets')).rows,
          unrelated: (await db.query('TABLE unrelated_workspace.documents')).rows,
          policy: (await db.query("SELECT * FROM pg_policy WHERE polname='workspaces service only'")).rows,
          tablePrivileges: (await db.query("SELECT oid,relacl,relowner,relrowsecurity FROM pg_class WHERE oid IN ('storage.objects'::regclass,'storage.buckets'::regclass,'public.apps_tenants'::regclass,'public.tenant_users'::regclass) ORDER BY oid")).rows,
          auth: (await db.query("SELECT nspacl,nspowner,proacl,proowner FROM pg_namespace JOIN pg_proc ON pronamespace=pg_namespace.oid WHERE nspname='auth'")).rows,
        };
      }
      const before = await snapshot();
      await install();
      assert.deepEqual(await snapshot(), before);
      const first = await config();
      assert.deepEqual(first, {
        version:1, requirement_id:a.requirement, tenant_id:a.tenant, schema:a.schema, bucket:a.bucket,
        user_id:owner, site_id:site, status:'active', policy_version:1, file_size_limit:10485760,
        allowed_mime_types:['image/jpeg','image/png','image/webp','image/gif','application/pdf',
          'text/plain','text/csv','application/json','application/octet-stream'],
      });
      await install();
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await config(), first);
      assert.equal((await db.query("SELECT count(*)::int AS count FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname LIKE 'apps_tenant_storage_%'")).rows[0].count, 4);
      const protections = (await db.query("SELECT proname,prosecdef,proconfig,pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname IN ('apps_storage_object_allowed','apps_get_tenant_storage_config') ORDER BY proname")).rows;
      assert.deepEqual(protections, [
        {proname:'apps_get_tenant_storage_config',prosecdef:true,proconfig:['search_path=pg_catalog'],owner:'installer'},
        {proname:'apps_storage_object_allowed',prosecdef:true,proconfig:['search_path=pg_catalog'],owner:'installer'},
      ]);
      for (const role of ['anon', 'authenticated']) {
        await asRole(role, user(), async () => {
          await denied(() => db.query('SELECT public.apps_get_tenant_storage_config($1,$2)', [a.requirement,a.tenant]));
          await denied(() => db.query("UPDATE public.apps_tenants SET status='destroyed'"));
          await denied(() => db.query('INSERT INTO public.tenant_users VALUES ($1,$2,$3)', [a.tenant,stranger,'owner']));
        });
      }
      await asRole('anon', backend(), async () => {
        await denied(() => helper(a.bucket, 'backend/seed.txt', owner));
        assert.deepEqual(await visible(), []);
        await denied(() => insert(a.bucket, 'backend/anon.txt', owner));
      });
      await asRole('service_role', {role:'service_role'}, async () => {
        await denied(() => helper(a.bucket, 'backend/seed.txt', owner));
        assert.deepEqual(await visible(), [], 'no Storage bypass or new service policy granted');
        assert.deepEqual((await visible('workspaces')).map(row => row.name), ['logo.png']);
      });
      await request(user(stranger), async () => {
        assert.deepEqual(await visible(), []);
        assert.deepEqual(await visible('workspaces'), []);
      });
      // Config is metadata, not proof a bucket exists, and works in a read-only transaction.
      await db.query('DELETE FROM storage.objects WHERE bucket_id=$1', [a.bucket]);
      await db.query('DELETE FROM storage.buckets WHERE id=$1', [a.bucket]);
      await db.query("UPDATE public.apps_tenants SET limits='{}' WHERE tenant_id=$1", [a.tenant]);
      await db.exec('BEGIN READ ONLY');
      assert.deepEqual(await config(), first);
      await db.exec('COMMIT');
      assert.equal((await db.query('SELECT count(*)::int AS count FROM storage.buckets WHERE id=$1', [a.bucket])).rows[0].count, 0);
    `);
  }, 35_000);

  it('rejects missing or tampered helper/policy protections rather than trusting policy names', () => {
    runOffline(String.raw`
      await install();
      const functionId = 'public.apps_storage_object_allowed(text,text,text)';
      const configId = 'public.apps_get_tenant_storage_config(uuid,uuid)';
      const mutations = [
        'DROP POLICY apps_tenant_storage_select ON storage.objects',
        'ALTER POLICY apps_tenant_storage_select ON storage.objects USING (true)',
        'ALTER POLICY apps_tenant_storage_insert ON storage.objects WITH CHECK (true)',
        'ALTER POLICY apps_tenant_storage_update ON storage.objects USING (true)',
        'ALTER POLICY apps_tenant_storage_update ON storage.objects WITH CHECK (true)',
        'ALTER POLICY apps_tenant_storage_delete ON storage.objects TO PUBLIC',
        'ALTER TABLE storage.objects DISABLE ROW LEVEL SECURITY',
        'DROP FUNCTION ' + functionId + ' CASCADE',
        'ALTER FUNCTION ' + functionId + ' SECURITY INVOKER',
        'ALTER FUNCTION ' + functionId + ' SET search_path TO public,pg_catalog',
        'ALTER FUNCTION ' + functionId + ' OWNER TO authenticated',
        'ALTER FUNCTION ' + functionId + ' IMMUTABLE',
        'ALTER FUNCTION ' + functionId + ' STRICT',
        'ALTER FUNCTION ' + functionId + ' PARALLEL SAFE',
        'ALTER ROLE authenticated BYPASSRLS',
        'ALTER ROLE anon SUPERUSER',
        'ALTER TABLE storage.objects OWNER TO authenticated',
        'ALTER TABLE storage.objects OWNER TO supabase_storage_admin; GRANT supabase_storage_admin TO authenticated',
        'GRANT EXECUTE ON FUNCTION ' + functionId + ' TO PUBLIC',
        'GRANT EXECUTE ON FUNCTION ' + functionId + ' TO anon',
        'GRANT EXECUTE ON FUNCTION ' + functionId + ' TO service_role',
        'GRANT EXECUTE ON FUNCTION ' + functionId + ' TO authenticated WITH GRANT OPTION',
        'REVOKE EXECUTE ON FUNCTION ' + functionId + ' FROM authenticated',
        'GRANT EXECUTE ON FUNCTION ' + configId + ' TO PUBLIC',
        'GRANT EXECUTE ON FUNCTION ' + configId + ' TO authenticated',
        'GRANT EXECUTE ON FUNCTION ' + configId + ' TO service_role WITH GRANT OPTION',
        'CREATE FUNCTION public.apps_storage_object_allowed(text,text) RETURNS boolean LANGUAGE sql AS \'SELECT true\'',
        'CREATE FUNCTION public.apps_get_tenant_storage_config(uuid) RETURNS jsonb LANGUAGE sql AS \'SELECT NULL::jsonb\'',
        'CREATE OR REPLACE FUNCTION public.apps_storage_object_allowed(p_bucket text,p_name text,p_owner_id text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS \'BEGIN RETURN true; END;\'',
        'GRANT installer TO authenticated',
      ];
      for (const mutation of mutations) {
        await db.exec('BEGIN');
        await db.exec(mutation);
        await assert.rejects(() => config(), /authorization protections are missing or changed/, mutation);
        await db.exec('ROLLBACK');
        assert.equal((await config()).policy_version, 1);
      }
    `);
  }, 35_000);

  it('rolls back cleanly when the non-superuser installer cannot manage Supabase-owned Storage policies', () => {
    runOffline(String.raw`
      await db.exec('ALTER TABLE storage.objects OWNER TO supabase_storage_admin');
      const before = (await db.query('TABLE pg_auth_members')).rows;
      await assert.rejects(() => install(), error => {
        assert.equal(error.code, '42501');
        assert.match(error.message, /must be owner|permission denied/);
        return true;
      });
      assert.deepEqual((await db.query('TABLE pg_auth_members')).rows, before);
      assert.equal((await db.query("SELECT to_regprocedure('public.apps_storage_object_allowed(text,text,text)') AS helper")).rows[0].helper, null);
      assert.equal((await db.query("SELECT to_regprocedure('public.apps_get_tenant_storage_config(uuid,uuid)') AS config")).rows[0].config, null);
      assert.equal((await db.query("SELECT count(*)::int AS count FROM pg_policy WHERE polrelid='storage.objects'::regclass")).rows[0].count, 1);
      assert.equal((await db.query("SELECT count(*)::int AS count FROM public.tenant_users")).rows[0].count, 3);
      // A later failed reapply also preserves the already-installed functions/policies.
      await db.exec('ALTER TABLE storage.objects OWNER TO installer');
      await install();
      const functionsBefore = (await db.query("SELECT oid,prosrc,proacl,proowner FROM pg_proc WHERE proname IN ('apps_storage_object_allowed','apps_get_tenant_storage_config') ORDER BY oid")).rows;
      const policiesBefore = (await db.query("SELECT * FROM pg_policy WHERE polrelid='storage.objects'::regclass ORDER BY oid")).rows;
      await db.exec('ALTER TABLE storage.objects OWNER TO supabase_storage_admin');
      await assert.rejects(() => install(), /must be owner|permission denied/);
      assert.deepEqual((await db.query("SELECT oid,prosrc,proacl,proowner FROM pg_proc WHERE proname IN ('apps_storage_object_allowed','apps_get_tenant_storage_config') ORDER BY oid")).rows, functionsBefore);
      assert.deepEqual((await db.query("SELECT * FROM pg_policy WHERE polrelid='storage.objects'::regclass ORDER BY oid")).rows, policiesBefore);
    `);
  }, 35_000);

  it('blocks unsafe legacy mutation RPCs and unknown permissive policies without repairing unrelated objects', () => {
    runOffline(String.raw`
      const unsafeNames = ['exec_sql', 'execute_sql', 'insert_schema_table_row',
        'update_schema_table_row', 'delete_schema_table_row', 'delete_schema_table_rows'];
      const unchanged = async () => ({
        functions: (await db.query("SELECT oid,proname,prosrc,proacl,proowner FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows,
        policies: (await db.query("SELECT * FROM pg_policy WHERE polrelid='storage.objects'::regclass ORDER BY oid")).rows,
        members: (await db.query('TABLE public.tenant_users')).rows,
      });
      for (const name of unsafeNames) {
        await db.exec('CREATE FUNCTION public.' + name + "(q text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN NULL; END'");
        const before = await unchanged();
        await assert.rejects(() => install(), /operator repair of unsafe public mutation RPC privileges/);
        assert.deepEqual(await unchanged(), before, 'installation must not silently repair or change the platform');
        await db.exec('REVOKE ALL ON FUNCTION public.' + name + '(text) FROM PUBLIC,anon,authenticated');
        await db.exec('GRANT EXECUTE ON FUNCTION public.' + name + '(text) TO service_role');
        await install();
        assert.equal((await config()).version, 1);
        for (const role of ['anon', 'authenticated']) {
          await db.exec('GRANT EXECUTE ON FUNCTION public.' + name + '(text) TO ' + role);
          await assert.rejects(() => config(), /operator repair of unsafe public mutation RPC privileges/);
          const unsafe = await unchanged();
          await assert.rejects(() => install(), /operator repair of unsafe public mutation RPC privileges/);
          assert.deepEqual(await unchanged(), unsafe);
          await db.exec('REVOKE ALL ON FUNCTION public.' + name + '(text) FROM ' + role);
        }
        assert.equal((await config()).version, 1);
      }
      for (const policy of [
        'CREATE POLICY broad_read ON storage.objects FOR SELECT TO authenticated USING (true)',
        'CREATE POLICY broad_write ON storage.objects FOR INSERT TO authenticated WITH CHECK (true)',
        'CREATE POLICY unknown_bucket ON storage.objects FOR ALL TO authenticated USING (bucket_id=\'other\') WITH CHECK (bucket_id=\'other\')',
        'ALTER POLICY "workspaces service only" ON storage.objects USING (true)',
        'ALTER POLICY "workspaces service only" ON storage.objects WITH CHECK (true)',
        'ALTER POLICY "workspaces service only" ON storage.objects TO authenticated',
      ]) {
        await db.exec('BEGIN');
        await db.exec(policy);
        await assert.rejects(() => config(), /operator review of unrelated permissive Storage policies/);
        await db.exec('ROLLBACK');
      }
      await db.exec('CREATE POLICY broad_read ON storage.objects FOR SELECT USING (true)');
      const unsafe = await unchanged();
      await assert.rejects(() => install(), /operator review of unrelated permissive Storage policies/);
      assert.deepEqual(await unchanged(), unsafe);
      await db.exec('DROP POLICY broad_read ON storage.objects');
      assert.equal((await config()).version, 1);
      await db.exec('CREATE FUNCTION public.apps_storage_object_allowed(text,text) RETURNS boolean LANGUAGE sql AS \'SELECT true\'');
      await assert.rejects(() => install(), /Conflicting reserved Apps Storage function/);
      await db.exec('DROP FUNCTION public.apps_storage_object_allowed(text,text)');
      await db.exec('ALTER FUNCTION public.apps_storage_object_allowed(text,text,text) OWNER TO authenticated');
      await assert.rejects(() => install(), /Conflicting reserved Apps Storage function/);
      await db.exec('ALTER FUNCTION public.apps_storage_object_allowed(text,text,text) OWNER TO installer');
      await db.exec('CREATE ROLE unexpected_executor');
      await db.exec('GRANT EXECUTE ON FUNCTION public.apps_storage_object_allowed(text,text,text) TO unexpected_executor');
      const broadAcl = await unchanged();
      await assert.rejects(() => install(), /function privileges are not isolated/);
      assert.deepEqual(await unchanged(), broadAcl);
      await db.exec('REVOKE ALL ON FUNCTION public.apps_storage_object_allowed(text,text,text) FROM unexpected_executor');
      // Ownership round-trip above merged the former authenticated grantee into
      // owner privileges; a normal reapply restores the exact intended ACL.
      await install();
      await db.exec('ALTER ROLE authenticated BYPASSRLS');
      await assert.rejects(() => install(), /authorization roles are not isolated/);
      await db.exec('ALTER ROLE authenticated NOBYPASSRLS');
      assert.equal((await config()).version, 1);
    `);
  }, 35_000);

  it('contains no Storage metadata writes, membership backfill, auth grants or role elevation', () => {
    expect(migration).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+storage\.(?:buckets|objects)\b/i);
    expect(migration).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.tenant_users\b/i);
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE)\b[^;]*\bauth\./i);
    expect(migration).not.toMatch(/\b(?:CREATE|ALTER)\s+ROLE\b|\bSET\s+ROLE\b|\bOWNER\s+TO\b/i);
    expect(migration).toContain('file_size_limit\', 10485760');
  });
});