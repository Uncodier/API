import { canAutomaticallyReplaceMigration, sanitizeMigrationRepairContext } from '@/lib/services/apps-platform/migration-repair-policy';

describe('conservative migration repair policy', () => {
  const ddl = 'CREATE TABLE records (id uuid, user_id uuid); ALTER TABLE records ENABLE ROW LEVEL SECURITY;';
  const policy = 'CREATE POLICY own_records ON records USING (true);';
  const fixed = 'CREATE POLICY own_records ON records USING (auth.uid() = user_id);';

  it('permits scoped policy repair without rewriting table creation', () => {
    expect(canAutomaticallyReplaceMigration(ddl + policy, ddl + fixed)).toBe(true);
  });

  it.each([
    fixed, ddl, ddl.replace('user_id uuid', 'owner uuid') + fixed,
    ddl + fixed + 'UPDATE records SET user_id = NULL;',
    ddl + fixed.replace('own_records', 'other_policy'),
  ])('refuses erased structural intent or policy identity', sql => {
    expect(canAutomaticallyReplaceMigration(ddl + policy, sql)).toBe(false);
  });

  it('does not automatically rewrite dynamic SQL or infer a data backfill', () => {
    expect(canAutomaticallyReplaceMigration('DO $$ BEGIN NULL; END $$;', fixed)).toBe(false);
    expect(canAutomaticallyReplaceMigration("INSERT INTO records VALUES ('original');" + policy,
      "INSERT INTO records VALUES ('different');" + fixed)).toBe(false);
  });

  it('cannot broaden a read policy to all operations or another role', () => {
    const original = 'CREATE POLICY scoped ON records FOR SELECT TO authenticated USING (true);';
    expect(canAutomaticallyReplaceMigration(original,
      'CREATE POLICY scoped ON records FOR ALL TO authenticated USING (auth.uid() = user_id);')).toBe(false);
    expect(canAutomaticallyReplaceMigration(original,
      'CREATE POLICY scoped ON records FOR SELECT TO anon USING (auth.uid() = user_id);')).toBe(false);
  });

  it('redacts recognizable secrets but preserves process.env references', () => {
    expect(sanitizeMigrationRepairContext('const token = "abc"; const key = process.env.APPS_TOKEN;'))
      .toBe('const token = "[REDACTED]"; const key = process.env.APPS_TOKEN;');
  });
});