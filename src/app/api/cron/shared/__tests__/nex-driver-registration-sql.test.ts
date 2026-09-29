import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lintMigration } from '@/lib/services/apps-platform/migration-linter';

const sql = readFileSync(resolve(process.cwd(), 'supabase/tenant-migrations/app_5a1d6caa92a4420d80f25673/0001_initial_schema.sql'), 'utf8');
const hardening = readFileSync(resolve(process.cwd(), 'supabase/tenant-migrations/app_5a1d6caa92a4420d80f25673/0002_pin_registration_function_search_path.sql'), 'utf8');
const schema = 'app_5a1d6caa92a4420d80f25673';
const tenant = '49f4d8b1-52cb-4abb-8387-da487c64deaf';
const backend = '541396e1-a904-4a81-8cbf-0ca4e3b8b2b4';

describe('NEX driver registration tenant migration', () => {
  it('passes the production tenant linter without privileged SQL', () => {
    expect(lintMigration({ sql, schema, tenant_id: tenant })).toEqual({ ok: true, errors: [], warnings: [] });
    expect(lintMigration({ sql: hardening, schema, tenant_id: tenant })).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('persists atomically, denies other identities, prevents escalation and enforces bounds', () => {
    const script = `
      import { PGlite } from '@electric-sql/pglite';
      const db = new PGlite();
      const schema = ${JSON.stringify(schema)};
      const backend = ${JSON.stringify(backend)};
      const tenant = ${JSON.stringify(tenant)};
      await db.exec(\`
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE tenant_owner NOLOGIN NOINHERIT;
        CREATE SCHEMA auth;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub','')::uuid $$;
        CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
        -- Deliberately no auth USAGE: production tenant owners do not have it.
        CREATE SCHEMA \${schema} AUTHORIZATION tenant_owner;
        GRANT USAGE ON SCHEMA \${schema} TO authenticated, anon;
        ALTER DEFAULT PRIVILEGES FOR ROLE tenant_owner IN SCHEMA \${schema} GRANT ALL ON TABLES TO authenticated, anon;
        SET ROLE tenant_owner;
      \`);
      await db.exec(${JSON.stringify(sql)});
      await db.exec(${JSON.stringify(hardening)});
      await db.exec('RESET ROLE');
      const call = \`SELECT \${schema}.register_driver($1,$2,$3,$4,$5) AS receipt\`;
      const input = ['John Doe','driver@example.com','Truck','ABC-1234',5000];
      const claims = {sub:backend, tenant_id:tenant, schema};
      async function identity(role, payload) {
        await db.exec('RESET ROLE');
        await db.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify(payload)]);
        await db.exec('SET ROLE ' + role);
      }
      async function failure(query,args=[]) {try {await db.query(query,args);return null;}catch(e){return e.code;}}
      await identity('anon',{});
      const anonDenied = await failure(call,input);
      await identity('authenticated',{sub:'11111111-1111-4111-8111-111111111111',tenant_id:tenant,schema});
      const otherUserDenied = await failure(call,input);
      await identity('authenticated',{...claims,tenant_id:'22222222-2222-4222-8222-222222222222'});
      const otherTenantDenied = await failure(call,input);
      await identity('authenticated',{sub:backend});
      const ownerLoginDenied = await failure(call,input);
      await identity('authenticated',claims);
      const receipt = (await db.query(call,input)).rows[0].receipt;
      const repeated = (await db.query(call,input)).rows[0].receipt;
      const duplicatePlate = await failure(call,['Other Driver','other@example.com','Truck','ABC-1234',5000]);
      const rows = (await db.query(\`SELECT u.full_name,u.role,v.user_id,v.capacity FROM \${schema}.users u JOIN \${schema}.vehicles v ON v.user_id=u.id\`)).rows;
      const badCapacity = await failure(call,['Bad Driver','bad@example.com','Truck','BAD-1234',-1]);
      const invalidEmail = await failure(call,['Bad Driver','invalid','Truck','BAD-1234',5000]);
      await identity('authenticated',{sub:receipt.user_id});
      const update = await db.query(\`UPDATE \${schema}.users SET role='admin' WHERE id=$1 RETURNING id\`,[receipt.user_id]);
      const unauthorizedInsert = await failure(\`INSERT INTO \${schema}.users(id,email,role) VALUES ($1,'evil@example.com','admin')\`,['33333333-3333-4333-8333-333333333333']);
      await identity('authenticated',{sub:'11111111-1111-4111-8111-111111111111'});
      const otherRead = (await db.query(\`SELECT * FROM \${schema}.users\`)).rows.length;
      await db.exec('RESET ROLE');
      const counts = (await db.query(\`SELECT (SELECT count(*) FROM \${schema}.users)::int AS users,(SELECT count(*) FROM \${schema}.vehicles)::int AS vehicles\`)).rows[0];
      await db.exec(\`INSERT INTO \${schema}.users(id,email,role) SELECT gen_random_uuid(),'limit-'||g||'@example.com','driver' FROM generate_series(1,49) g\`);
      await identity('authenticated',claims);
      const rateLimit = await failure(call,['Limited Driver','limit@example.com','Truck','NEW-1234',5000]);
      console.log(JSON.stringify({anonDenied,otherUserDenied,otherTenantDenied,ownerLoginDenied,receipt,repeated,duplicatePlate,rows,badCapacity,invalidEmail,escalationRows:update.rows.length,unauthorizedInsert,otherRead,counts,rateLimit}));
      await db.close();
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 25000 });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'PGlite failure');
    const report = JSON.parse(child.stdout.trim());
    expect(report).toMatchObject({ anonDenied: '42501', otherUserDenied: '42501', otherTenantDenied: '42501', ownerLoginDenied: '42501', duplicatePlate: '23505', badCapacity: '22023', invalidEmail: '22023', escalationRows: 0, unauthorizedInsert: '42501', otherRead: 0, counts: { users: 1, vehicles: 1 }, rateLimit: 'P0001' });
    expect(report.receipt).toEqual(report.repeated);
    expect(report.rows).toEqual([{ full_name: 'John Doe', role: 'driver', user_id: report.receipt.user_id, capacity: '5000' }]);
  }, 30000);
});