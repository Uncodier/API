import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lintMigration } from '../migration-linter';
import { splitSqlStatements } from '../migration-sql-text';

const skill = readFileSync(
  resolve(__dirname, '../../../../skills/makinari-rol-backend/SKILL.md'),
  'utf8',
);

// Match the canonical Supabase guidance test: include indented fences, SQL
// language aliases, and optional metadata. Lint the source, not copied fixtures.
function extractSqlBlocks(markdown: string) {
  const fence = /^[ \t]*(`{3,}|~{3,})(?:sql|postgresql|postgres)\b[^\r\n]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gim;
  return Array.from(markdown.matchAll(fence), (match, index) => ({
    label: `SQL block ${index + 1}, SKILL.md:${markdown.slice(0, match.index).split('\n').length}`,
    sql: match[2],
  }));
}

const sqlBlocks = extractSqlBlocks(skill);
const executableExamples = Array.from(
  skill.matchAll(/^[ \t]*(`{3,}|~{3,})(?:sql|postgresql|postgres|ts|tsx|js|javascript|typescript)\b[^\r\n]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gim),
  (match) => match[2],
).join('\n');
const prose = skill.replace(/[`*]/g, '').replace(/\s+/g, ' ');

// Pure lexical contexts, never capability manifests or database connections.
// Distinct schemas ensure examples cannot depend on one copied tenant name.
const tenantFixtures = [
  {
    schema: 'app_111111112222433384445555',
    tenant_id: '00000000-0000-4000-8000-000000000001',
  },
  {
    schema: 'app_aaaaaaaa222243338444bbbb',
    tenant_id: '00000000-0000-4000-8000-000000000002',
  },
];

describe('Backend migration skill guidance', () => {
  it.each([
    { indent: '', fence: '```', language: 'sql', metadata: '', newline: '\n' },
    { indent: '  ', fence: '```', language: 'sql', metadata: '', newline: '\n' },
    { indent: '\t', fence: '~~~~', language: 'postgresql', metadata: ' title="migration"', newline: '\r\n' },
    { indent: '    ', fence: '````', language: 'POSTGRES', metadata: '', newline: '\n' },
  ])('extracts $language fences with indentation "$indent" unchanged', ({ indent, fence, language, metadata, newline }) => {
    const sql = `${indent}ALTER TABLE reservations ADD COLUMN notes text;${newline}`;
    const markdown = `${indent}${fence}${language}${metadata}${newline}${sql}${indent}${fence}${newline}`;
    expect(extractSqlBlocks(markdown)).toEqual([
      { label: 'SQL block 1, SKILL.md:1', sql },
    ]);
  });

  it('discovers every SQL block, including the indented new-table migration', () => {
    const openings = skill.match(/^[ \t]*(?:`{3,}|~{3,})(?:sql|postgresql|postgres)\b/gim) ?? [];
    expect(sqlBlocks).toHaveLength(openings.length);
    // Do not pass by deleting examples, renaming fences, or skipping indented SQL.
    expect(sqlBlocks.length).toBeGreaterThanOrEqual(7);
    expect(skill).toMatch(/^[ \t]+(?:`{3,}|~{3,})sql\b/im);
  });

  it('retains a complete user-owned CRUD migration and a static schema evolution example', () => {
    const creation = sqlBlocks.find(({ sql }) => /CREATE TABLE(?: IF NOT EXISTS)? reservations\b/i.test(sql))?.sql;
    expect(creation).toBeDefined();
    expect(creation).toMatch(/ALTER TABLE reservations ENABLE ROW LEVEL SECURITY/i);
    for (const operation of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(creation).toMatch(new RegExp(`FOR ${operation} TO authenticated`, 'i'));
    }
    expect(creation?.match(/_app_current_user_id\(\) = user_id/g)).toHaveLength(5);
    expect(sqlBlocks.some(({ sql }) => /ALTER TABLE reservations ADD COLUMN IF NOT EXISTS notes text/i.test(sql))).toBe(true);
    expect(sqlBlocks.some(({ sql }) => /CREATE INDEX IF NOT EXISTS reservations_user_starts_at_idx/i.test(sql))).toBe(true);
  });

  it('defers capabilities and identity to the canonical Supabase skill', () => {
    expect(skill).toContain('../makinari-obj-apps-supabase/SKILL.md');
    expect(prose).toMatch(/verified version 1 manifest.*system context.*sandbox_db_capabilities/);
    expect(prose).toContain('requirement_id, tenant_id, schema');
    expect(prose).toContain('stop the dependent work and report the specific provisioning gap');
    expect(prose).toContain('Do not invent IDs, schemas, helper names, buckets, or RPCs');
    expect(prose).toContain('Do not inspect env secrets or decode tokens to discover capabilities');
    for (const helper of ['_app_current_user_id', '_app_request_claims', '_app_is_backend_request']) {
      expect(skill).toContain(`${helper}()`);
    }
    expect(prose).toContain('platform-owned and immutable');
    expect(prose).toContain('Do not create, replace, alter, rename, drop, or shadow them');
    expect(prose).toContain('identity, not tenant or organization membership');
    expect(prose).toContain('Never authorize from user_metadata');
    expect(prose).toMatch(/persisted function definitions, fully qualify every helper call and tenant table reference with the exact schema from the verified manifest/);
  });

  it('keeps SDK operations bound to the verified schema without fallbacks', () => {
    expect(prose).toContain("NEXT_PUBLIC_APPS_TENANT_SCHEMA must match the verified manifest's schema");
    expect(prose).toContain('No fallback to public, generic Supabase envs, or another tenant');
    expect(prose).toMatch(/\.schema\(\).*before.*\.from\(\).*\.rpc\(\)/);
    expect(executableExamples).toMatch(/\.schema\(SCHEMA_NAME\)\.from\(/);
    expect(executableExamples).not.toMatch(/NEXT_PUBLIC_SUPABASE_|(?:\|\||\?\?)\s*['"]public['"]/i);
  });

  it('prohibits global/dynamic SQL and leaves search_path to the runner', () => {
    expect(prose).toContain('static, tenant-only SQL');
    expect(prose).toContain('DO blocks and dynamic SQL (EXECUTE) are forbidden');
    expect(prose).toContain('Never enumerate or loop over schemas');
    expect(prose).toContain('The migration runner owns search_path');
    expect(prose).toContain('Do not set or override it');
    expect(prose).toContain('GRANT / REVOKE and schema, role, or extension administration are forbidden');
    expect(prose).toContain('Fix rejected SQL; never weaken the linter or bypass sandbox_db_migrate');
  });

  it('preserves applied files and distinguishes repairs to pending migrations', () => {
    expect(prose).toContain('Applied migrations are immutable');
    expect(prose).toContain('Preserve their original path and exact contents, including comments and whitespace');
    expect(prose).toContain('Pending, never-applied migrations may be edited');
    expect(prose).toContain('Confirm application status from migration receipts');
    expect(prose).toContain('merely appending a later migration cannot unblock it');
    expect(prose).toContain('new uniquely named, ordered forward migration');
    expect(prose).toContain('Do not modify ledger rows or invoke privileged SQL RPCs');
    expect(prose).toContain('Applied SQL migrations are excluded from refactoring');
  });

  it('keeps dummy data out of production and test mode free of DB writes', () => {
    expect(prose).toContain('Never insert dummy/test data into production or production migrations');
    expect(prose).toContain('Test fixtures belong only in isolated test environments');
    expect(prose).toContain('?mode=test remains side-effect-free and must not write DB rows');
    expect(prose).not.toMatch(/Inserción de Datos de Prueba|DEBES insertar elementos de prueba|mandatory dummy data/i);
  });

  it('does not reintroduce forbidden inline SQL or legacy prose recommendations', () => {
    expect(skill).not.toMatch(/\b(?:using|with\s+check)\s*\(\s*true\s*\)/i);
    expect(skill).not.toMatch(/\bapp_[a-f0-9]+\b|\bauth\s*\.\s*(?:uid|jwt)\s*\(/i);
    expect(prose).not.toMatch(/Dynamic Table Verification|Migraciones Multi-Schema|Si creas scripts DO/i);
    expect(prose).not.toMatch(/Keep admin checks in WITH CHECK|USING \(true\) for intentionally public reads/i);
    expect(prose).not.toMatch(/backend-only by service role|backend\/service flow still works/i);
  });

  it('protects control-table writes and preserves correlated organization access', () => {
    expect(prose).toContain('no direct user writes to membership, role, or permissions');
    expect(prose).toContain('moving a recursive lookup into WITH CHECK does not solve recursion');
    expect(prose).toContain('Do not silently change a shared organization model to creator-only ownership');
    expect(prose).toContain('permissive policies combine with OR');
    const membership = sqlBlocks.find(({ sql }) => /CREATE POLICY organization_memberships_self_read\b/.test(sql))?.sql;
    expect(membership).toMatch(/FOR SELECT TO authenticated\s+USING \(user_id = _app_current_user_id\(\)\)/);
    expect(membership).not.toMatch(/FOR\s+(?:INSERT|UPDATE|DELETE|ALL)\b/i);
    const projects = sqlBlocks.find(({ sql }) => /CREATE POLICY projects_editor_access\b/.test(sql))?.sql;
    expect(projects).toMatch(/CREATE POLICY projects_member_read[\s\S]*?FOR SELECT TO authenticated/);
    expect(projects?.match(/m\.organization_id = projects\.organization_id/g)).toHaveLength(3);
    expect(projects?.match(/m\.user_id = _app_current_user_id\(\)/g)).toHaveLength(3);
    expect(projects?.match(/m\.role IN \('editor', 'admin'\)/g)).toHaveLength(2);
  });

  it('does not promise backend RLS bypass or public table access', () => {
    expect(prose).toContain('backend.role is authenticated and backend.bypasses_rls is false');
    expect(prose).toContain('backend.operations: [] means no app-specific backend operations are registered');
    expect(prose).toContain('not an RLS bypass, membership grant, or authorized data operation');
    expect(prose).toContain('explicit product authorization contract');
    expect(prose).toContain('operation-specific RLS using the provisioned backend helper');
    expect(prose).toContain('A server-side JWT does not automatically override a deny predicate');
    expect(prose).toContain('Public intake and catalog reads are not exceptions');
    expect(prose).toContain('a route handler alone is not authorization');
    expect(prose).toContain('Lint success is not proof of runtime SQL behavior or business authorization');
  });

  describe.each(tenantFixtures)('real linter with tenant schema $schema', (tenant) => {
    it.each(sqlBlocks)('accepts $label without rewriting or autofixing SQL', ({ sql }) => {
      expect(lintMigration({ ...tenant, sql })).toEqual({ ok: true, errors: [], warnings: [] });
    });
  });

  it.each(sqlBlocks)('$label is executable, static, tenant-local SQL with runner-owned search_path', ({ sql }) => {
    const statements = splitSqlStatements(sql);
    expect(statements.some(({ code }) => code.trim().length > 0)).toBe(true);
    for (const { code } of statements) {
      // Some tenant-local SET variants and legacy auth calls pass lexical lint;
      // the guidance contract intentionally forbids teaching them anyway.
      expect(code).not.toMatch(/\bset\s+(?:(?:local|session)\s+)?search_path\b|\bset_config\s*\(/i);
      expect(code).not.toMatch(/\b(?:public|auth|storage)\s*\./i);
      expect(code).not.toMatch(/^\s*DO\b|\bEXECUTE\b|information_schema\.schemata|\bpg_namespace\b/i);
      expect(code).not.toMatch(/\b(?:using|with\s+check)\s*\(\s*_app_current_user_id\(\)\s+is\s+not\s+null\s*\)/i);
    }
  });
});