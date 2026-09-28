import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(__dirname, '../../../../../..');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260928223000_apps_pending_migration_repair_check.sql'),
  'utf8',
);
const schema = 'app_111111112222433384445555';
const tenantId = '00000000-0000-4000-8000-000000000001';
const freshKey = 'migration:supabase/migrations/0002_pending.sql';
const freshChecksum = 'a'.repeat(64);
const validArgs = [schema, tenantId, freshKey, freshChecksum];
const invalidInputs = [
  { name: 'foreign schema', args: ['public', ...validArgs.slice(1)] },
  { name: 'short example schema', args: ['app_123', ...validArgs.slice(1)] },
  { name: 'quoted schema injection', args: [`${schema}"; SELECT 1; --`, ...validArgs.slice(1)] },
  { name: 'null schema', args: [null, ...validArgs.slice(1)] },
  { name: 'missing migration key prefix', args: [schema, tenantId, '0002.sql', freshChecksum] },
  { name: 'non-SQL migration key', args: [schema, tenantId, 'migration:migrations/0002.ts', freshChecksum] },
  { name: 'migration key injection', args: [schema, tenantId, `${freshKey}; SELECT 1;`, freshChecksum] },
  { name: 'null migration key', args: [schema, tenantId, null, freshChecksum] },
  { name: 'short checksum', args: [schema, tenantId, freshKey, 'abc'] },
  { name: 'non-hex checksum', args: [schema, tenantId, freshKey, 'z'.repeat(64)] },
  { name: 'uppercase checksum', args: [schema, tenantId, freshKey, 'A'.repeat(64)] },
  { name: 'null checksum', args: [schema, tenantId, freshKey, null] },
];

type Attempt = { value?: { repairable: boolean }; error?: string; code?: string };
let report: {
  fresh: Attempt;
  appliedKey: Attempt;
  legacyKey: Attempt;
  alias: Attempt;
  otherTenantChecksum: Attempt;
  wrongTenant: Attempt;
  nullTenant: Attempt;
  inactiveTenant: Attempt;
  invalid: Record<string, Attempt>;
  denied: Record<string, Attempt>;
  directLedgerRead: Attempt;
  privileges: { role: string; can_execute: boolean }[];
  functionInfo: { owner: string; security_definer: boolean; public_execute: boolean; config: string[] };
  ledgerUnchanged: boolean;
};

beforeAll(() => {
  // Run the actual migration in a fresh in-memory database, with no Supabase
  // client, environment loading, persistent data directory, or network access.
  const script = `
    import { PGlite } from '@electric-sql/pglite';
    const db = new PGlite();
    const schema = ${JSON.stringify(schema)};
    const tenantId = ${JSON.stringify(tenantId)};
    const args = ${JSON.stringify(validArgs)};
    const otherSchema = 'app_222222223333444485556666';
    const otherTenant = '00000000-0000-4000-8000-000000000002';
    const inactiveTenant = '00000000-0000-4000-8000-000000000003';
    const signature = 'public.apps_check_pending_migration_repair(text,uuid,text,text)';
    const rpc = 'SELECT public.apps_check_pending_migration_repair($1,$2,$3,$4) AS value';
    async function attempt(role, values, query = rpc) {
      await db.exec('SET ROLE ' + role);
      try {
        const result = await db.query(query, values);
        return { value: result.rows[0]?.value };
      } catch (error) {
        return { error: error.message, code: error.code };
      } finally {
        await db.exec('RESET ROLE');
      }
    }
    try {
      await db.exec(\`
        CREATE ROLE apps_migration_coordinator NOLOGIN NOSUPERUSER NOBYPASSRLS;
        CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
        CREATE ROLE anon NOLOGIN NOSUPERUSER;
        CREATE ROLE authenticated NOLOGIN NOSUPERUSER;
        CREATE ROLE public_only NOLOGIN NOSUPERUSER;
        GRANT USAGE ON SCHEMA public TO apps_migration_coordinator, service_role, anon, authenticated, public_only;
        CREATE TABLE public.apps_tenants (
          tenant_id uuid PRIMARY KEY, schema text NOT NULL UNIQUE, status text NOT NULL
        );
        INSERT INTO public.apps_tenants VALUES
          ('\${tenantId}', '\${schema}', 'active'),
          ('\${otherTenant}', '\${otherSchema}', 'active'),
          ('\${inactiveTenant}', 'app_333333334444455586667777', 'inactive');
        ALTER TABLE public.apps_tenants ENABLE ROW LEVEL SECURITY;
        GRANT SELECT ON public.apps_tenants TO apps_migration_coordinator;
        CREATE POLICY coordinator_read ON public.apps_tenants
          FOR SELECT TO apps_migration_coordinator USING (true);
      \`);
      for (const name of [schema, otherSchema]) {
        await db.exec(\`
          CREATE SCHEMA \${name} AUTHORIZATION apps_migration_coordinator;
          CREATE TABLE \${name}._meta (key text PRIMARY KEY, value jsonb NOT NULL);
          ALTER TABLE \${name}._meta ENABLE ROW LEVEL SECURITY;
          ALTER TABLE \${name}._meta OWNER TO apps_migration_coordinator;
          GRANT USAGE ON SCHEMA \${name} TO service_role;
        \`);
      }
      await db.query(\`INSERT INTO \${schema}._meta VALUES ($1,$2),($3,$4),($5,$6)\`, [
        'migration:migrations/0001_applied.sql', JSON.stringify({ checksum: 'b'.repeat(64) }),
        'migration:migrations/0000_legacy.sql', JSON.stringify({ applied_at: '2026-01-01' }),
        'metadata:not-a-migration', JSON.stringify({ checksum: args[3] }),
      ]);
      await db.query(\`INSERT INTO \${otherSchema}._meta VALUES ($1,$2)\`, [
        args[2], JSON.stringify({ checksum: 'c'.repeat(64) }),
      ]);
      await db.exec(${JSON.stringify(migration)});
      const ledger = () => db.query(\`
        SELECT '\${schema}' AS schema, key, value FROM \${schema}._meta
        UNION ALL SELECT '\${otherSchema}', key, value FROM \${otherSchema}._meta
        ORDER BY schema, key
      \`);
      const before = await ledger();
      const fresh = await attempt('service_role', args);
      const appliedKey = await attempt('service_role', [schema, tenantId, 'migration:migrations/0001_applied.sql', args[3]]);
      const legacyKey = await attempt('service_role', [schema, tenantId, 'migration:migrations/0000_legacy.sql', args[3]]);
      const alias = await attempt('service_role', [schema, tenantId, 'migration:migrations/renamed.sql', 'b'.repeat(64)]);
      const otherTenantChecksum = await attempt('service_role', [schema, tenantId, args[2], 'c'.repeat(64)]);
      const wrongTenant = await attempt('service_role', [schema, otherTenant, ...args.slice(2)]);
      const nullTenant = await attempt('service_role', [schema, null, ...args.slice(2)]);
      const inactive = await attempt('service_role', ['app_333333334444455586667777', inactiveTenant, ...args.slice(2)]);
      const invalid = {};
      for (const input of ${JSON.stringify(invalidInputs)}) {
        invalid[input.name] = await attempt('service_role', input.args);
      }
      const denied = {};
      for (const role of ['anon', 'authenticated', 'public_only']) {
        denied[role] = await attempt(role, args);
      }
      const directLedgerRead = await attempt('service_role', [], \`SELECT * FROM \${schema}._meta\`);
      const privileges = await db.query(\`
        SELECT role, has_function_privilege(role, $1, 'EXECUTE') AS can_execute
        FROM unnest(ARRAY['service_role','anon','authenticated','public_only']) AS roles(role)
      \`, [signature]);
      const functionInfo = await db.query(\`
        SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS security_definer,
          proconfig AS config,
          EXISTS (SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner))) a
            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
        FROM pg_proc WHERE oid = $1::regprocedure
      \`, [signature]);
      console.log(JSON.stringify({
        fresh, appliedKey, legacyKey, alias, otherTenantChecksum, wrongTenant, nullTenant,
        inactiveTenant: inactive, invalid, denied, directLedgerRead,
        privileges: privileges.rows, functionInfo: functionInfo.rows[0],
        ledgerUnchanged: JSON.stringify(before.rows) === JSON.stringify((await ledger()).rows),
      }));
    } finally {
      await db.close();
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (child.status !== 0) {
    throw new Error(child.stderr?.slice(-4_000) || child.error?.message || 'PGlite pending migration repair check failed');
  }
  report = JSON.parse(child.stdout.trim());
}, 25_000);

describe('pending migration repair SQL RPC', () => {
  it('allows a fresh key/checksum but ignores non-migration metadata and other tenants', () => {
    expect(report.fresh).toEqual({ value: { repairable: true } });
    expect(report.otherTenantChecksum).toEqual({ value: { repairable: true } });
  });

  it.each(['appliedKey', 'legacyKey', 'alias'] as const)('refuses already applied SQL: %s', field => {
    expect(report[field]).toEqual({ value: { repairable: false } });
  });

  it.each(['wrongTenant', 'nullTenant', 'inactiveTenant'] as const)('rejects %s before reading another ledger', field => {
    expect(report[field]).toEqual({ error: 'Tenant and schema do not match an active tenant', code: 'P0001' });
  });

  it.each(invalidInputs)('rejects invalid lookup input: $name', ({ name }) => {
    expect(report.invalid[name]).toEqual({ error: 'Invalid pending migration repair lookup', code: 'P0001' });
  });

  it('grants EXECUTE only to service_role, not anon/authenticated/PUBLIC', () => {
    expect(report.privileges).toEqual([
      { role: 'service_role', can_execute: true },
      { role: 'anon', can_execute: false },
      { role: 'authenticated', can_execute: false },
      { role: 'public_only', can_execute: false },
    ]);
    expect(report.functionInfo).toEqual({
      owner: 'apps_migration_coordinator', security_definer: true,
      config: ['search_path=public, pg_temp'], public_execute: false,
    });
  });

  it.each(['anon', 'authenticated', 'public_only'])('denies actual RPC execution by %s', role => {
    expect(report.denied[role]).toMatchObject({ code: '42501', error: expect.stringContaining('permission denied for function') });
  });

  it('leaves the protected ledger unchanged without granting direct service-role access', () => {
    expect(report.directLedgerRead).toMatchObject({ code: '42501', error: expect.stringContaining('permission denied') });
    expect(report.ledgerUnchanged).toBe(true);
  });
});