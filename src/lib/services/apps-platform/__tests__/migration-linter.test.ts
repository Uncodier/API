import { lintMigration } from '../migration-linter';

const input = (sql: string) => ({
  schema: 'app_123',
  tenant_id: 'tenant-123',
  sql,
});

describe('tenant migration linter', () => {
  it('rejects dynamic cross-schema DDL', () => {
    const result = lintMigration(input(`
      DO $$
      DECLARE target_schema text;
      BEGIN
        FOR target_schema IN
          SELECT schema_name
          FROM information_schema.schemata
          WHERE schema_name LIKE 'app_%'
        LOOP
          EXECUTE format(
            'ALTER TABLE %I.campaigns ENABLE ROW LEVEL SECURITY',
            target_schema
          );
        END LOOP;
      END
      $$;
    `));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'dynamic-schema-scope' }),
    ]));
  });

  it('rejects unconditional authenticated policies', () => {
    const result = lintMigration(input(`
      CREATE POLICY campaigns_authenticated
      ON campaigns
      FOR ALL
      TO authenticated
      USING (true)
      WITH CHECK (true);
    `));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'permissive-authenticated-policy' }),
    ]));
  });

  it('accepts an ownership-scoped policy', () => {
    const result = lintMigration(input(`
      CREATE POLICY campaigns_owner
      ON campaigns
      FOR ALL
      TO authenticated
      USING (created_by = auth.uid())
      WITH CHECK (created_by = auth.uid());
    `));

    expect(result.ok).toBe(true);
  });

  it('accepts a trigger on a tenant-local table', () => {
    const result = lintMigration(input(`
      CREATE TRIGGER campaigns_touch
      BEFORE UPDATE ON campaigns
      FOR EACH ROW EXECUTE FUNCTION touch_row();
    `));

    expect(result.ok).toBe(true);
  });

  it.each([
    'INSERT INTO public.campaigns (id) VALUES (1);',
    'UPDATE other.campaigns SET name = \'x\';',
    'DELETE FROM public.campaigns;',
    'SELECT * FROM public.campaigns;',
    'SELECT public.apps_exec_sql(concat(\'DROP \', \'TABLE public.apps_tenants\'));',
    'DROP FUNCTION _execute_tenant_migration(text);',
    'SELECT * INTO leaked_records FROM records;',
    'ALTER VIEW exposed_records RESET (security_invoker);',
    'ALTER TABLE campaigns DISABLE ROW LEVEL SECURITY;',
    'SET search_path TO public;',
    'SELECT set_config(\'search_path\', \'public\', true);',
    'PREPARE unsafe AS SELECT 1;',
  ])('rejects unsafe SQL: %s', (sql) => {
    expect(lintMigration(input(sql)).ok).toBe(false);
  });

  it.each([
    'CREATE INDEX campaigns_name_idx ON public.campaigns (name);',
    'CREATE POLICY campaigns_owner ON public.campaigns USING (created_by = auth.uid());',
    'CREATE TRIGGER campaigns_touch BEFORE UPDATE ON public.campaigns EXECUTE FUNCTION touch_row();',
  ])('rejects a cross-schema ON target: %s', (sql) => {
    expect(lintMigration(input(sql)).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'schema-scope' }),
      ]),
    );
  });

  it('rejects access to the protected migration ledger', () => {
    const result = lintMigration(input(
      `UPDATE _meta SET value = '{}'::jsonb WHERE key = 'migration:x.sql';`,
    ));

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'migration-ledger-protected' }),
    ]));
  });

  it('does not lint comments or string values as executable SQL', () => {
    const result = lintMigration(input(`
      -- Never EXECUTE or DROP SCHEMA public from a tenant migration.
      SELECT 'public.apps_exec_sql; DROP SCHEMA and _meta are text';
    `));

    expect(result).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  it('still inspects executable code inside a routine body', () => {
    const result = lintMigration(input(`
      CREATE FUNCTION app_123.escape_attempt()
      RETURNS void
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        PERFORM public.apps_exec_sql('SELECT 1');
      END;
      $function$;
    `));

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'qualified-function-scope' }),
    ]));
  });

  it.each([
    `
      CREATE FUNCTION unsafe() RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER
      AS $$ BEGIN NULL; END; $$;
    `,
    `
      CREATE FUNCTION unsafe() RETURNS void
      LANGUAGE plpgsql
      AS 'BEGIN ALTER TABLE records DISABLE ROW LEVEL SECURITY; END';
    `,
    `
      CREATE FUNCTION unsafe() RETURNS text
      LANGUAGE sql
      AS U&'SELECT public.apps_exec_sql(NULL)';
    `,
    'CREATE VIEW exposed_records AS SELECT * FROM records;',
    'CREATE RECURSIVE VIEW exposed_records(id) AS SELECT id FROM records;',
    'CREATE MATERIALIZED VIEW exposed_records AS SELECT * FROM records;',
  ])('rejects RLS-bypassing schema objects', (sql) => {
    expect(lintMigration(input(sql)).ok).toBe(false);
  });

  it('accepts a caller-rights view', () => {
    const result = lintMigration(input(`
      CREATE VIEW visible_records
      WITH (security_invoker = true)
      AS SELECT * FROM records;
    `));

    expect(result.ok).toBe(true);
  });

  it.each([
    'ALTER POLICY owner_only ON records USING (true);',
    'ALTER POLICY owner_only ON records USING ((true) OR owner_id = auth.uid());',
    'ALTER POLICY owner_only ON records USING (auth.uid() = auth.uid());',
    'CREATE POLICY owner_only ON records USING (auth.uid() = auth.uid());',
  ])('rejects unconditional policy changes: %s', (sql) => {
    expect(lintMigration(input(sql)).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: 'permissive-authenticated-policy',
        }),
      ]),
    );
  });

  it('accepts a non-null guard when it is combined with row ownership', () => {
    const result = lintMigration(input(`
      CREATE POLICY owner_only ON records
      USING (
        auth.uid() IS NOT NULL
        AND owner_id = auth.uid()
      );
    `));

    expect(result.ok).toBe(true);
  });

  it('rejects a policy that omits its predicates', () => {
    const result = lintMigration(input(`
      CREATE POLICY campaigns_open
      ON campaigns
      FOR SELECT
      TO authenticated;
    `));

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'permissive-authenticated-policy' }),
    ]));
  });

  it('fails a new table that has RLS but no policy', () => {
    const result = lintMigration(input(`
      CREATE TABLE projects (id uuid PRIMARY KEY);
      ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
    `));

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: 'tenant-policy-required',
        severity: 'error',
      }),
    ]));
  });

  it('requires RLS and a policy for unlogged tables', () => {
    const result = lintMigration(input(`
      CREATE UNLOGGED TABLE projects (id uuid PRIMARY KEY);
    `));

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'rls-required' }),
      expect.objectContaining({ rule: 'tenant-policy-required' }),
    ]));
  });
});
