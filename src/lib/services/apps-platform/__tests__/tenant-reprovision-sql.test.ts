import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const forwardMigration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260926080000_apps_tenant_idempotent_reprovision.sql',
  ),
  'utf8',
);

describe('Apps tenant reprovisioning', () => {
  it('keeps bootstrap atomic but skips ownership DDL for an existing isolated tenant', () => {
    expect(forwardMigration).toMatch(/IF NOT was_created THEN[\s\S]*?RETURN jsonb_build_object\([\s\S]*?'created', false[\s\S]*?END IF;/i);
    expect(forwardMigration).toMatch(/IF NOT was_created THEN[\s\S]*?Existing tenant % has incomplete isolated bootstrap/i);
    expect(forwardMigration.indexOf('IF NOT was_created THEN')).toBeLessThan(
      forwardMigration.indexOf('ALTER TABLE %I._meta ENABLE ROW LEVEL SECURITY'),
    );
    expect(forwardMigration).toContain('ALTER TABLE %I._meta OWNER TO apps_migration_coordinator');
    expect(forwardMigration).toContain('GRANT EXECUTE ON FUNCTION public.apps_ensure_tenant(');
  });

  it('returns a receipt without touching the coordinator-owned ledger for a non-superuser installer', () => {
    const script = `
      import { PGlite } from '@electric-sql/pglite';
      const db = new PGlite();
      const migration = ${JSON.stringify(forwardMigration)};
      const req = '11111111-2222-4333-8444-555555555555';
      const schema = 'app_111111112222433384445555';
      const owner = 'app_owner_111111112222433384445555';
      await db.exec(\`
        CREATE ROLE installer LOGIN;
        CREATE ROLE apps_migration_coordinator NOLOGIN;
        CREATE ROLE \${owner} NOLOGIN NOINHERIT;
        CREATE ROLE service_role NOLOGIN;
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE TABLE public.apps_tenants (
          tenant_id uuid PRIMARY KEY,
          requirement_id uuid NOT NULL UNIQUE,
          user_id uuid NOT NULL,
          site_id uuid NOT NULL,
          schema text NOT NULL,
          bucket text NOT NULL,
          auth_provider text NOT NULL,
          status text NOT NULL
        );
        GRANT SELECT, UPDATE ON public.apps_tenants TO installer;
        GRANT USAGE ON SCHEMA public TO installer, service_role;
        GRANT \${owner} TO installer WITH INHERIT TRUE, SET TRUE;
        CREATE SCHEMA \${schema} AUTHORIZATION \${owner};
        CREATE TABLE \${schema}._meta (key text PRIMARY KEY, value jsonb NOT NULL);
        ALTER TABLE \${schema}._meta ENABLE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON \${schema}._meta USING (false);
        ALTER TABLE \${schema}._meta OWNER TO apps_migration_coordinator;
        CREATE FUNCTION \${schema}._execute_tenant_migration(p_sql text)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN EXECUTE p_sql; END';
        ALTER FUNCTION \${schema}._execute_tenant_migration(text) OWNER TO \${owner};
        INSERT INTO public.apps_tenants VALUES (
          '00000000-0000-4000-8000-000000000001', '\${req}',
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000003',
          '\${schema}', 'tenant-111111112222433384445555', 'supabase', 'active'
        );
      \`);
      await db.exec(migration);
      await db.exec('ALTER FUNCTION public.apps_ensure_tenant(uuid,uuid,uuid,uuid,text) OWNER TO installer');
      await db.exec('SET ROLE installer');
      let cannotAlterLedger = false;
      try {
        await db.exec(\`ALTER TABLE \${schema}._meta ENABLE ROW LEVEL SECURITY\`);
      } catch (error) {
        cannotAlterLedger = /must be owner|permission denied/i.test(String(error));
      }
      await db.exec('RESET ROLE');
      await db.exec('SET ROLE service_role');
      const args = [req, '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003', 'supabase'];
      const first = await db.query('SELECT public.apps_ensure_tenant($1,$2,$3,$4,$5)', args);
      const second = await db.query('SELECT public.apps_ensure_tenant($1,$2,$3,$4,$5)', args);
      await db.exec('RESET ROLE');
      const broken = '22222222-2222-4333-8444-555555555555';
      await db.exec(\`
        INSERT INTO public.apps_tenants VALUES (
          '00000000-0000-4000-8000-000000000005', '\${broken}',
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000003',
          'app_222222222222433384445555', 'tenant-222222222222433384445555',
          'supabase', 'active'
        )
      \`);
      await db.exec('SET ROLE service_role');
      let incompleteRejected = false;
      try {
        await db.query('SELECT public.apps_ensure_tenant($1,$2,$3,$4,$5)',
          [broken, ...args.slice(1)]);
      } catch (error) {
        incompleteRejected = /incomplete isolated bootstrap/i.test(String(error));
      }
      await db.exec('RESET ROLE');
      const ledger = await db.query(
        \`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class
         WHERE oid = '\${schema}._meta'::regclass\`
      );
      console.log(JSON.stringify({
        cannotAlterLedger,
        first: first.rows[0].apps_ensure_tenant,
        second: second.rows[0].apps_ensure_tenant,
        ledgerOwner: ledger.rows[0].owner,
        incompleteRejected,
      }));
      await db.close();
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (result.status !== 0) {
      throw new Error(
        result.stderr?.slice(-3_000) || 'PGlite reprovision check failed',
      );
    }
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      cannotAlterLedger: true,
      first: { tenant_id: '00000000-0000-4000-8000-000000000001', created: false },
      second: { tenant_id: '00000000-0000-4000-8000-000000000001', created: false },
      ledgerOwner: 'apps_migration_coordinator',
      incompleteRejected: true,
    });
  }, 25_000);
});