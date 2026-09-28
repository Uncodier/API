import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lintMigration } from '../migration-linter';
import { splitSqlStatements } from '../migration-sql-text';

const skill = readFileSync(
  resolve(__dirname, '../../../../skills/makinari-obj-apps-supabase/SKILL.md'),
  'utf8',
);

// Read the documentation itself, not copied SQL fixtures or a mocked linter.
// Accept SQL language aliases, indentation, and optional fence metadata.
const sqlFence = /^[ \t]*(`{3,}|~{3,})(?:sql|postgresql|postgres)\b[^\r\n]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gim;
const sqlBlocks = Array.from(skill.matchAll(sqlFence), (match, index) => ({
  label: `SQL block ${index + 1}, SKILL.md:${skill.slice(0, match.index).split('\n').length}`,
  sql: match[2],
}));

// Pure lexical fixtures: no database, applier, Next config, or network imports.
// app_123 is valid linter context (not a production provisioning schema).
const tenantFixtures = [
  { schema: 'app_123', tenant_id: '00000000-0000-4000-8000-000000000001' },
  {
    schema: 'app_111111112222433384445555',
    tenant_id: '00000000-0000-4000-8000-000000000002',
  },
];

describe('Supabase migration skill guidance', () => {
  it('discovers every SQL block and retains substantive migration examples', () => {
    const openings = skill.match(/^[ \t]*(?:`{3,}|~{3,})(?:sql|postgresql|postgres)\b/gim) ?? [];
    expect(sqlBlocks).toHaveLength(openings.length);
    // Do not silently pass if fences are removed/renamed or extraction breaks.
    expect(sqlBlocks.length).toBeGreaterThanOrEqual(5);
  });

  it('does not reintroduce unconditional predicates in inline advice', () => {
    // The previous control-table anti-pattern section recommended open reads
    // outside its SQL fences, contradicting otherwise scoped templates.
    expect(skill).not.toMatch(/\b(?:using|with\s+check)\s*\(\s*true\s*\)/i);
  });

  describe.each(tenantFixtures)('real linter with tenant schema $schema', (tenant) => {
    it.each(sqlBlocks)('accepts $label without rewriting or autofixing it', ({ sql }) => {
      expect(lintMigration({ ...tenant, sql })).toEqual({
        ok: true,
        errors: [],
        warnings: [],
      });
    });
  });

  it.each(sqlBlocks)('$label leaves search_path to the migration runner', ({ sql }) => {
    const statements = splitSqlStatements(sql);
    expect(statements.some(({ code }) => code.trim().length > 0)).toBe(true);
    // This is also a guidance invariant: the lexical linter does not reject
    // every tenant-local SET variant, but examples must not teach any of them.
    for (const { code } of statements) {
      expect(code).not.toMatch(/\bset\s+(?:(?:local|session)\s+)?search_path\b/i);
      expect(code).not.toMatch(/\bset_config\s*\(/i);
    }
  });

  it.each([
    {
      label: 'DO wrappers',
      sql: 'DO $$ BEGIN NULL; END $$;',
      rule: 'forbidden-statement',
    },
    {
      label: 'schema enumeration',
      sql: 'SELECT schema_name FROM information_schema.schemata;',
      rule: 'dynamic-schema-scope',
    },
    {
      label: 'dynamic SQL',
      sql: `DO $$ BEGIN EXECUTE format('ALTER TABLE %I.reservations ENABLE ROW LEVEL SECURITY', 'app_123'); END $$;`,
      rule: 'dynamic-schema-scope',
    },
    {
      label: 'tenant-authored grants',
      sql: 'GRANT INSERT ON reservations TO anon;',
      rule: 'forbidden-statement',
    },
    {
      label: 'tenant-authored revokes',
      sql: 'REVOKE INSERT ON reservations FROM anon;',
      rule: 'forbidden-statement',
    },
    {
      label: 'open public intake',
      sql: 'CREATE POLICY public_intake ON reservations FOR INSERT TO anon WITH CHECK (true);',
      rule: 'permissive-authenticated-policy',
    },
    {
      label: 'open catalog reads',
      sql: 'CREATE POLICY public_catalog ON studios FOR SELECT TO anon USING (true);',
      rule: 'permissive-authenticated-policy',
    },
    {
      label: 'authentication without row ownership or membership',
      sql: 'CREATE POLICY logged_in ON projects TO authenticated USING (auth.uid() IS NOT NULL);',
      rule: 'permissive-authenticated-policy',
    },
  ])('does not exempt $label from the current linter', ({ sql, rule }) => {
    const result = lintMigration({ ...tenantFixtures[0], sql });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule, severity: 'error' }),
    ]));
  });
});