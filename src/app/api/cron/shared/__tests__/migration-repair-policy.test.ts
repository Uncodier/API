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

  it.each([
    ['"OwnerOnly"', '"owneronly"', '"Records"', '"Records"', 'authenticated', 'authenticated'],
    ['"OwnerOnly"', '"OwnerOnly"', '"Records"', '"records"', 'authenticated', 'authenticated'],
    ['scoped', 'scoped', 'records', 'records', '"Staff"', '"staff"'],
    ['scoped', 'scoped', 'records', 'records', '"Staff  Team"', '"Staff Team"'],
  ])('preserves case and spacing of quoted policy/table/role names', (beforePolicy, afterPolicy, beforeTable, afterTable, beforeRole, afterRole) => {
    expect(canAutomaticallyReplaceMigration(
      `CREATE POLICY ${beforePolicy} ON ${beforeTable} FOR SELECT TO ${beforeRole} USING (true);`,
      `CREATE POLICY ${afterPolicy} ON ${afterTable} FOR SELECT TO ${afterRole} USING (user_id = _app_current_user_id());`,
    )).toBe(false);
  });

  it('still accepts case-insensitive unquoted SQL keywords and exact quoted names', () => {
    expect(canAutomaticallyReplaceMigration(
      'CREATE POLICY "OwnerOnly" ON "Records" FOR SELECT TO "Staff" USING (true);',
      'create policy "OwnerOnly" on "Records" for select to "Staff" using (user_id = _app_current_user_id());',
    )).toBe(true);
  });

  it('does not parse predicate keywords inside quoted identifiers as the policy boundary', () => {
    expect(canAutomaticallyReplaceMigration(
      'CREATE POLICY scoped ON "Records using (Original)" FOR SELECT TO authenticated USING (true);',
      'CREATE POLICY scoped ON "Records using (Changed)" FOR ALL TO authenticated USING (user_id = _app_current_user_id());',
    )).toBe(false);
  });

  it('redacts recognizable secrets but preserves process.env references', () => {
    expect(sanitizeMigrationRepairContext('const token = "abc"; const key = process.env.APPS_TOKEN;'))
      .toBe('const token = "[REDACTED]"; const key = process.env.APPS_TOKEN;');
  });

  it.each(['política', '权限', 'policy$owner', '"Owner\'s /* -- $$ ""Policy"""'])('tracks every policy, including %s', name => {
    const extra = `CREATE POLICY ${name} ON records FOR SELECT TO authenticated USING (true);`;
    const scoped = extra.replace('(true)', '(user_id = auth.uid())');
    expect(canAutomaticallyReplaceMigration(ddl + policy + extra, ddl + fixed + scoped)).toBe(true);
    expect(canAutomaticallyReplaceMigration(ddl + policy + extra, ddl + fixed)).toBe(false);
    expect(canAutomaticallyReplaceMigration(ddl + policy, ddl + fixed + scoped)).toBe(false);
    expect(canAutomaticallyReplaceMigration(ddl + policy + extra,
      ddl + fixed + scoped.replace('FOR SELECT', 'FOR ALL'))).toBe(false);
    expect(canAutomaticallyReplaceMigration(ddl + policy + extra,
      ddl + fixed + scoped.replace('TO authenticated', 'TO anon'))).toBe(false);
  });

  it.each([
    'CREATE POLICY 123 ON records USING (true);',
    'CREATE POLICY unknown ON records.extra.too_many USING (true);',
    'CREATE POLICY unknown ON records FOR SOMETHING USING (true);',
    'ALTER POLICY unknown ON records RENAME TO other;',
    'ALTER POLICY unknown ON records USING (true) TO anon;',
    'ALTER POLICY unknown ON records USING (true) "trailing";',
    'ALTER POLICY unknown ON records USING ();',
    'CREATE POLICY unknown ON records USING (true) WITH CHECK (true) USING (true);',
    'CREATE POLICY U&"pol\\00edtica" ON records USING (true);',
    '/* unterminated',
    "SELECT 'unterminated; ALTER TABLE records DISABLE ROW LEVEL SECURITY;",
    'SELECT "unterminated;',
    'SELECT $missing$unterminated;',
    'CREATE POLICY unknown ON records USING ((true);',
  ])('refuses the entire repair if any statement cannot be parsed: %s', unknown => {
    expect(canAutomaticallyReplaceMigration(policy + unknown, fixed + unknown)).toBe(false);
    expect(canAutomaticallyReplaceMigration(policy + unknown, fixed)).toBe(false);
    expect(canAutomaticallyReplaceMigration(policy, fixed + unknown)).toBe(false);
  });

  it.each([
    'SET standard_conforming_strings = off;',
    'SET LOCAL "standard_conforming_strings" TO on;',
    'RESET standard_conforming_strings;',
    'RESET ALL;',
    "SELECT set_config('standard_conforming_strings', 'off', false);",
  ])('refuses repairs that retain a string-semantics change: %s', setting => {
    expect(canAutomaticallyReplaceMigration(setting + policy, setting + fixed)).toBe(false);
  });

  it('does not treat backslashes as escapes in ordinary strings or identifiers', () => {
    const prefix = String.raw`SELECT '\'; SELECT 1 AS "ends\";`;
    expect(canAutomaticallyReplaceMigration(prefix + policy, prefix + fixed)).toBe(true);
    expect(canAutomaticallyReplaceMigration(prefix + policy,
      prefix.replace('SELECT 1', 'SELECT 2') + fixed)).toBe(false);
  });

  it.each([
    ['"Owner\'s"', '"Owner s"'],
    ['"Staff /* One */"', '"Staff /* Two */"'],
    ['"Staff -- One"', '"Staff -- Two"'],
    ['"Staff $$ One $$"', '"Staff $$ Two $$"'],
    ['"Staff ""One"""', '"Staff ""one"""'],
  ])('preserves quoted header text that looks like literals or comments (%s)', (beforeName, afterName) => {
    const original = `CREATE POLICY scoped ON records FOR SELECT TO ${beforeName} USING (true);`;
    const replacement = original.replace('(true)', '(user_id = auth.uid())');
    expect(canAutomaticallyReplaceMigration(original, replacement)).toBe(true);
    expect(canAutomaticallyReplaceMigration(original, replacement.replace(beforeName, afterName))).toBe(false);
  });

  it('preserves ALTER policy roles and quoted non-ASCII table names', () => {
    const original = 'ALTER POLICY política ON "Registros  Privados" TO "Staff", authenticated USING (true);';
    const replacement = original.replace('(true)', '(user_id = auth.uid())');
    expect(canAutomaticallyReplaceMigration(original, replacement)).toBe(true);
    expect(canAutomaticallyReplaceMigration(original, replacement.replace('authenticated', 'anon'))).toBe(false);
    expect(canAutomaticallyReplaceMigration(original, replacement.replace('Privados', 'privados'))).toBe(false);
  });

  it.each([
    ['polÍtica', 'política'],
    ['own\u00a0records', 'own records'],
    ['own\u00a0\u00a0records', 'own\u00a0records'],
    ['records\u00a0', 'records'],
  ])('does not normalize significant non-ASCII identifier characters (%s)', (beforeName, afterName) => {
    const original = `CREATE POLICY ${beforeName} ON ${beforeName} USING (true);`;
    expect(canAutomaticallyReplaceMigration(original, original.replace('(true)', '(user_id = auth.uid())'))).toBe(true);
    expect(canAutomaticallyReplaceMigration(original,
      `CREATE POLICY ${afterName} ON ${afterName} USING (user_id = auth.uid());`)).toBe(false);
  });
});