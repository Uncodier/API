import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const bootstrapMigration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260923193900_create_apps_platform_tables.sql',
  ),
  'utf8',
);
const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260923194000_apply_tenant_migration_atomically.sql',
  ),
  'utf8',
);
const provisioningMigration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260923194100_ensure_tenant_atomically.sql',
  ),
  'utf8',
);

describe('atomic tenant migration SQL', () => {
  it('versions the RLS-protected registry before dependent RPCs', () => {
    expect(bootstrapMigration).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.apps_tenants/i,
    );
    expect(bootstrapMigration).toMatch(
      /ALTER TABLE public\.apps_tenants ENABLE ROW LEVEL SECURITY/i,
    );
    expect(bootstrapMigration).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.tenant_users/i,
    );
    expect(bootstrapMigration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.apps_exec_sql\(text\)\s+TO service_role/i,
    );
    expect(migration).toContain(
      'Missing public.apps_tenants; apply migration 20260923193900 first',
    );
  });

  it('keeps tenant registry creation and schema bootstrap in one lock', () => {
    expect(provisioningMigration).toContain(
      "hashtextextended('tenant:' || p_requirement_id::text, 0)",
    );
    expect(provisioningMigration).toMatch(
      /INSERT INTO public\.apps_tenants[\s\S]*?CREATE SCHEMA %I/i,
    );
  });

  it('runs tenant SQL as a constrained non-login role', () => {
    expect(migration).toMatch(
      /CREATE ROLE %I NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE/i,
    );
    expect(migration).toContain(
      'AND (rolsuper OR rolreplication OR rolbypassrls)',
    );
    expect(provisioningMigration).toContain(
      'AND (rolsuper OR rolreplication OR rolbypassrls)',
    );
    expect(migration).not.toMatch(
      /ALTER ROLE[^;]*(?:NOSUPERUSER|NOREPLICATION|NOBYPASSRLS)/i,
    );
    expect(provisioningMigration).not.toMatch(
      /ALTER ROLE[^;]*(?:NOSUPERUSER|NOREPLICATION|NOBYPASSRLS)/i,
    );
    expect(migration).toMatch(
      /GRANT apps_migration_coordinator TO %I\s+WITH INHERIT FALSE, SET TRUE/i,
    );
    expect(migration).toMatch(
      /GRANT %I TO %I WITH INHERIT TRUE, SET TRUE/i,
    );
    expect(provisioningMigration).toMatch(
      /GRANT %I TO %I WITH INHERIT TRUE, SET TRUE/i,
    );
    expect(migration).toMatch(
      /GRANT USAGE, CREATE ON SCHEMA public TO apps_migration_coordinator/i,
    );
    expect(migration).toMatch(
      /REVOKE CREATE ON SCHEMA public FROM apps_migration_coordinator/i,
    );
    expect(provisioningMigration).toMatch(
      /GRANT USAGE, CREATE ON SCHEMA %I[\s\S]*?TO apps_migration_coordinator/i,
    );
    expect(provisioningMigration).toMatch(
      /REVOKE CREATE ON SCHEMA %I FROM apps_migration_coordinator/i,
    );
    expect(migration).toMatch(
      /ALTER FUNCTION %I\._execute_tenant_migration\(text\) OWNER TO %I/i,
    );
    expect(migration).toMatch(
      /SELECT %I\._execute_tenant_migration\(\$1\)/i,
    );
    expect(migration).toMatch(
      /ALTER FUNCTION public\.apps_apply_migration\([\s\S]*?\)\s+OWNER TO apps_migration_coordinator/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.apps_get_migration_receipt\([\s\S]*?\) TO service_role/i,
    );
    expect(migration).not.toMatch(
      /EXECUTE p_migration_sql/i,
    );
    expect(migration).not.toMatch(
      /GRANT[\s\S]*?ON FUNCTION public\.apps_exec_sql/i,
    );
  });

  it('serializes the tenant ledger and deduplicates applied checksums', () => {
    expect(migration).toContain(
      'pg_advisory_xact_lock(hashtextextended(p_target_schema, 0))',
    );
    expect(migration).toMatch(
      /value->>''checksum'' = \$1[\s\S]*?existing_checksum_key/i,
    );
    expect(migration).toMatch(
      /IF existing_checksum_key IS NOT NULL THEN\s+RETURN false;/i,
    );
    expect(migration).toMatch(
      /WHEN 'c' THEN 'ALTER TYPE %I\.%I OWNER TO %I'/i,
    );
    expect(migration).toMatch(
      /ALTER VIEW %I\.%I SET \(security_invoker = true\)/i,
    );
    expect(migration).toMatch(
      /ALTER ROUTINE %I\.%I\(%s\) SECURITY INVOKER/i,
    );
  });

  it('allows a non-superuser installer to set tenant owner default privileges', () => {
    const membership = /GRANT %I TO %I WITH INHERIT (?:TRUE|FALSE), SET TRUE/i;
    const script = `
      import { PGlite } from '@electric-sql/pglite';
      const db = new PGlite();
      const grants = ${JSON.stringify([
        migration.match(membership)?.[0],
        provisioningMigration.match(membership)?.[0],
      ])};
      await db.exec(
        'CREATE ROLE installer LOGIN; CREATE ROLE tenant_owner NOLOGIN NOINHERIT; ' +
        'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; ' +
        'CREATE ROLE service_role NOLOGIN; ' +
        'CREATE SCHEMA tenant_space;'
      );
      for (const grant of grants) {
        if (!grant) throw new Error('Missing owner membership grant');
        await db.exec(grant.replace('%I', 'tenant_owner').replace('%I', 'installer'));
        await db.exec('SET ROLE installer');
        for (const kind of ['TABLES', 'ROUTINES', 'SEQUENCES']) {
          await db.exec(
            'ALTER DEFAULT PRIVILEGES FOR ROLE tenant_owner IN SCHEMA tenant_space ' +
            'GRANT ALL PRIVILEGES ON ' + kind + ' TO anon, authenticated'
          );
        }
        await db.exec('RESET ROLE');
      }
      const checks = await db.query(
        "SELECT pg_has_role('installer', 'tenant_owner', 'USAGE') AS installer_inherits, " +
        "pg_has_role('service_role', 'tenant_owner', 'MEMBER') AS service_is_member, " +
        "(SELECT count(*)::integer FROM pg_default_acl WHERE defaclrole = " +
        "'tenant_owner'::regrole) AS default_acl_types"
      );
      console.log(JSON.stringify(checks.rows[0]));
      await db.close();
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      installer_inherits: true,
      service_is_member: false,
      default_acl_types: 3,
    });
  }, 25_000);

  it('executes SQL as the isolated tenant owner', () => {
    const script = `
      import { createHash } from 'node:crypto';
      import { PGlite } from '@electric-sql/pglite';
      const db = new PGlite();
      const migration = ${JSON.stringify(migration)};
      const schema = 'app_aaaaaaaaaaaaaaaaaaaaaaaa';
      const tenantId = '00000000-0000-4000-8000-000000000001';
      await db.exec(\`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.apps_tenants (
          tenant_id uuid PRIMARY KEY,
          schema text NOT NULL,
          status text NOT NULL
        );
        INSERT INTO public.apps_tenants VALUES (
          '\${tenantId}', '\${schema}', 'active'
        );
        CREATE SCHEMA \${schema};
        CREATE TABLE \${schema}._meta (
          key text PRIMARY KEY,
          value jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TYPE \${schema}.address AS (street text);
        CREATE TABLE \${schema}.private_records (id integer);
        CREATE VIEW \${schema}.private_records_view AS
          SELECT * FROM \${schema}.private_records;
        CREATE FUNCTION \${schema}.legacy_definer()
        RETURNS integer
        LANGUAGE sql
        SECURITY DEFINER
        AS 'SELECT 1';
      \`);
      await db.exec(migration);
      const sql =
        'ALTER TYPE address ADD ATTRIBUTE postcode text; ' +
        'CREATE TABLE first_table(id integer); ' +
        'CREATE TABLE second_table(id integer);';
      const checksum = createHash('sha256').update(sql).digest('hex');
      const apply = (key, body, hash) => db.query(
        'SELECT public.apps_apply_migration($1, $2, $3, $4, $5)',
        [schema, tenantId, key, hash, body],
      );
      await db.exec('SET ROLE service_role');
      const first = await apply('migration:test/001.sql', sql, checksum);
      const receipt = await db.query(
        'SELECT public.apps_get_migration_receipt($1, $2, $3)',
        [schema, tenantId, 'migration:test/001.sql'],
      );
      const renamed = await apply('migration:test/renamed.sql', sql, checksum);
      let crossSchemaDenied = false;
      try {
        await apply(
          'migration:test/forbidden.sql',
          \`UPDATE public.apps_tenants SET status = 'destroyed'\`,
          'b'.repeat(64),
        );
      } catch (error) {
        crossSchemaDenied = /permission denied/i.test(String(error));
      }
      await db.exec('RESET ROLE');
      const ledger = await db.query(
        \`SELECT count(*)::integer AS count FROM \${schema}._meta
         WHERE key LIKE 'migration:%'\`,
      );
      const owners = await db.query(
        \`SELECT tableowner FROM pg_catalog.pg_tables
         WHERE schemaname = '\${schema}' AND tablename = 'first_table'\`,
      );
      const hardening = await db.query(\`
        SELECT
          'security_invoker=true' = ANY(view.reloptions) AS view_invoker,
          NOT routine.prosecdef AS routine_invoker
        FROM pg_catalog.pg_class AS view
        JOIN pg_catalog.pg_namespace AS view_schema
          ON view_schema.oid = view.relnamespace
        CROSS JOIN pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS routine_schema
          ON routine_schema.oid = routine.pronamespace
        WHERE view_schema.nspname = '\${schema}'
          AND view.relname = 'private_records_view'
          AND routine_schema.nspname = '\${schema}'
          AND routine.proname = 'legacy_definer'
      \`);
      console.log(JSON.stringify({
        first: first.rows[0].apps_apply_migration,
        receiptFound:
          receipt.rows[0].apps_get_migration_receipt.found,
        renamed: renamed.rows[0].apps_apply_migration,
        crossSchemaDenied,
        ledgerCount: ledger.rows[0].count,
        tableOwner: owners.rows[0].tableowner,
        viewInvoker: hardening.rows[0].view_invoker,
        routineInvoker: hardening.rows[0].routine_invoker,
      }));
      await db.close();
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 20_000,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      first: true,
      receiptFound: true,
      renamed: false,
      crossSchemaDenied: true,
      ledgerCount: 1,
      tableOwner: 'app_owner_aaaaaaaaaaaaaaaaaaaaaaaa',
      viewInvoker: true,
      routineInvoker: true,
    });
  }, 25_000);

  it('provisions one tenant atomically across repeated callers', () => {
    const script = `
      import { PGlite } from '@electric-sql/pglite';
      const db = new PGlite();
      const migration = ${JSON.stringify(migration)};
      const provisioning = ${JSON.stringify(provisioningMigration)};
      const requirementId = '00000000-0000-4000-8000-000000000001';
      await db.exec(\`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
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
      \`);
      await db.exec(migration);
      await db.exec(provisioning);
      await db.exec('SET ROLE service_role');
      const ensure = (tenantId) => db.query(
        'SELECT public.apps_ensure_tenant($1, $2, $3, $4, $5)',
        [
          requirementId,
          tenantId,
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000003',
          'supabase',
        ],
      );
      const first = await ensure(
        '00000000-0000-4000-8000-000000000004',
      );
      const second = await ensure(
        '00000000-0000-4000-8000-000000000005',
      );
      await db.exec('RESET ROLE');
      const brokenRequirement =
        '11111111-2222-4333-8444-555555555555';
      const brokenSchema = 'app_111111112222433384445555';
      await db.exec(\`
        CREATE SCHEMA \${brokenSchema};
        CREATE VIEW \${brokenSchema}._meta AS SELECT 1 AS key;
        SET ROLE service_role;
      \`);
      let provisioningRolledBack = false;
      try {
        await db.query(
          'SELECT public.apps_ensure_tenant($1, $2, $3, $4, $5)',
          [
            brokenRequirement,
            '11111111-2222-4333-8444-555555555556',
            '00000000-0000-4000-8000-000000000002',
            '00000000-0000-4000-8000-000000000003',
            'supabase',
          ],
        );
      } catch {
        await db.exec('RESET ROLE');
        const failedRows = await db.query(
          'SELECT count(*)::integer AS count FROM public.apps_tenants WHERE requirement_id = $1',
          [brokenRequirement],
        );
        provisioningRolledBack = failedRows.rows[0].count === 0;
      }
      const tenants = await db.query(
        'SELECT count(*)::integer AS count FROM public.apps_tenants',
      );
      console.log(JSON.stringify({
        firstCreated: first.rows[0].apps_ensure_tenant.created,
        secondCreated: second.rows[0].apps_ensure_tenant.created,
        sameTenant:
          first.rows[0].apps_ensure_tenant.tenant_id ===
          second.rows[0].apps_ensure_tenant.tenant_id,
        tenantCount: tenants.rows[0].count,
        provisioningRolledBack,
      }));
      await db.close();
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 20_000,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      firstCreated: true,
      secondCreated: false,
      sameTenant: true,
      tenantCount: 1,
      provisioningRolledBack: true,
    });
  }, 25_000);
});
