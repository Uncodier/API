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
const executableExamples = Array.from(
  skill.matchAll(/^[ \t]*(`{3,}|~{3,})(?:sql|postgresql|postgres|ts|tsx|js|javascript|typescript)\b[^\r\n]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gim),
  (match) => match[2],
).join('\n');
const prose = skill.replace(/[`*]/g, '').replace(/\s+/g, ' ');
const identityHelpers = [
  '_app_current_user_id',
  '_app_request_claims',
  '_app_is_backend_request',
];

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
    expect(sqlBlocks.length).toBeGreaterThanOrEqual(6);
  });

  it('requires the verified version 1 manifest instead of inferred capabilities', () => {
    expect(prose).toMatch(/verified manifest passed in the system context or returned by sandbox_db_capabilities/);
    expect(skill).toMatch(/version:\s*1;/);
    expect(skill).toMatch(/requirement_id:\s*string;/);
    expect(skill).toMatch(/tenant_id:\s*string;/);
    expect(skill).toMatch(/schema:\s*Schema;/);
    expect(skill).toMatch(/user_id:\s*`\$\{Schema\}\._app_current_user_id`;/);
    expect(skill).toMatch(/claims:\s*`\$\{Schema\}\._app_request_claims`;/);
    expect(skill).toMatch(/backend:\s*`\$\{Schema\}\._app_is_backend_request`;/);
    expect(skill).toMatch(/storage:\s*\{\s*bucket:\s*string\s*\|\s*null;\s*available:\s*boolean\s*\}/);
    expect(skill).toMatch(/backend:\s*\{\s*role:\s*'authenticated';\s*bypasses_rls:\s*false;\s*operations:\s*\[\]\s*\}/);
    expect(prose).toContain('Never invent IDs, infer a schema from an ID, guess helpers');
    expect(prose).toContain('Do not manufacture a manifest, inspect env secrets');
    expect(prose).toContain('report the specific provisioning gap');
    // Concrete tenant IDs/schemas in a reusable skill can be copied as authority.
    expect(skill).not.toMatch(/\bapp_[a-f0-9]{8,}\b|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i);
  });

  it('keeps provisioned helpers immutable and fully qualifies persisted definitions', () => {
    for (const helper of identityHelpers) expect(skill).toContain(`${helper}()`);
    expect(prose).toContain('each tenant schema before the agent runs');
    expect(prose).toContain('platform-owned and immutable');
    expect(prose).toContain('Do not create, replace, alter, rename, drop, or shadow them');
    expect(prose).toContain('set request claims, or request auth/admin permissions');
    expect(prose).toMatch(/unqualified _app_current_user_id\(\) is valid because the runner sets the tenant search path/);
    expect(prose).toMatch(/persisted function definitions, fully qualify every helper call and tenant table reference with the exact schema from the verified manifest/);
    expect(prose).toContain("not a blanket authorization grant. Never authorize from user_metadata");
  });

  it('does not teach legacy identity calls, secret discovery, or public/dummy fallbacks', () => {
    expect(executableExamples).not.toMatch(/\bauth\s*\.\s*(?:uid|jwt|email|role)\s*\(/i);
    expect(executableExamples).not.toMatch(/\buser_metadata\b/i);
    expect(executableExamples).not.toMatch(/(?:\|\||\?\?)\s*['"]public['"]/i);
    expect(executableExamples).not.toMatch(/NEXT_PUBLIC_SUPABASE_|dummy\.supabase|dummy_key/i);
    expect(executableExamples).not.toMatch(/process\.env\.(?:APPS_TENANT_JWT|\w*(?:SECRET|SERVICE_ROLE)\w*)/i);
    expect(executableExamples).not.toMatch(/(?:Object\.(?:entries|values|keys)\(process\.env|JSON\.stringify\(process\.env)/);
    expect(executableExamples).not.toMatch(/\bset_config\s*\(|\brequest\.jwt|auth\.admin|shouldCreateUser:\s*true/i);
    expect(prose).toContain('Do not default to public, generic Supabase envs, a dummy URL/key');
  });

  it('keeps backend identity distinct from RLS bypass and registered operations', () => {
    expect(prose).toMatch(/_app_is_backend_request\(\) checks the exact trusted top-level sub, tenant_id, and schema claims/);
    expect(prose).toContain('provisioned registry binding');
    expect(prose).toContain('not a service-role credential, an RLS bypass, tenant/org membership, or a data operation');
    expect(prose).toContain('backend.operations: [] means no app-specific backend operations are registered');
    expect(prose).toContain('Do not invent an existing RPC');
    expect(prose).toMatch(/Inspect the actual tenant tables, policies, constraints, and any existing routines with sandbox_db_inspect/);
    expect(prose).toMatch(/Only when that contract authorizes it, implement a new app-specific transaction against the inspected schema/);
    expect(prose).toContain('operation-specific RLS using the provisioned backend helper');
    expect(prose).toContain('SECURITY INVOKER');
  });

  it('protects organization membership/roles without changing shared data to creator-only', () => {
    expect(prose).toContain('not tenant or organization membership');
    expect(prose).toContain('no direct user writes to membership, role, or permissions');
    expect(prose).toContain('Do not silently change a shared organization model to creator-only ownership');
    const membership = sqlBlocks.find(({ sql }) => /CREATE POLICY organization_memberships_self_read\b/.test(sql))?.sql;
    expect(membership).toBeDefined();
    expect(membership).toMatch(/FOR SELECT TO authenticated\s+USING \(user_id = _app_current_user_id\(\)\)/);
    expect(membership).not.toMatch(/FOR\s+(?:INSERT|UPDATE|DELETE|ALL)\b/i);
    const projects = sqlBlocks.find(({ sql }) => /CREATE POLICY projects_editor_access\b/.test(sql))?.sql;
    expect(projects).toBeDefined();
    expect(projects).toMatch(/CREATE POLICY projects_member_read[\s\S]*?FOR SELECT/);
    expect(projects?.match(/m\.organization_id = projects\.organization_id/g)).toHaveLength(3);
    expect(projects?.match(/m\.user_id = _app_current_user_id\(\)/g)).toHaveLength(3);
    expect(projects?.match(/m\.role IN \('editor', 'admin'\)/g)).toHaveLength(2);
  });

  it('does not create auth accounts for unverified public intake or grant roles on OTP login', () => {
    expect(prose).toContain('Public intake must not create an auth account');
    expect(prose).toContain('only after identity verification');
    expect(prose).toContain('moving an open insert into a route handler is not authorization');
    expect(executableExamples).toMatch(/shouldCreateUser:\s*false/);
    expect(executableExamples).not.toMatch(/\.upsert\s*\(|auth\.admin|\.createUser\s*\(/);
    expect(prose).toContain('never overwrite roles or existing profiles');
  });

  it('uses only reported storage capacity and reports gaps without global SQL', () => {
    expect(prose).toContain('Use only the exact storage.bucket reported by the verified manifest');
    expect(prose).toContain('storage.available is true and the bucket is non-null');
    expect(prose).toContain('specific storage capacity gap');
    expect(prose).toContain('Do not edit storage.buckets, storage.objects, storage policies, grants');
    expect(prose).toContain('No global SQL belongs in an app migration');
  });

  it('preserves the applied-vs-pending migration repair contract', () => {
    expect(prose).toContain('Applied migrations are immutable');
    expect(prose).toContain('Preserve their original path and exact contents, including comments and whitespace');
    expect(prose).toContain('Pending, never-applied migrations may be edited');
    expect(prose).toContain('merely appending a later migration cannot unblock it');
    expect(prose).toContain('Do not modify ledger rows or invoke privileged SQL RPCs yourself');
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

  it.each(sqlBlocks)('$label consumes local identity without redefining it or using login as authorization', ({ sql }) => {
    expect(sql).not.toMatch(/\bauth\s*\./i);
    // Match declaration targets, not harmless helper calls in app routine bodies.
    expect(sql).not.toMatch(/\b(?:create(?:\s+or\s+replace)?|alter|drop)\s+(?:function|procedure)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:"?\w+"?\s*\.\s*)?"?_app_(?:current_user_id|request_claims|is_backend_request)\b/i);
    expect(sql).not.toMatch(/\b(?:using|with\s+check)\s*\(\s*_app_current_user_id\(\)\s+is\s+not\s+null\s*\)/i);
    expect(sql).not.toMatch(/\b(?:public|auth|storage)\s*\./i);
  });

  describe.each(tenantFixtures)('platform helper calls with tenant schema $schema', (tenant) => {
    it.each(identityHelpers)('allows calls to %s, including inside an app-owned persisted routine', (helper) => {
      for (const sql of [
        `SELECT ${helper}(), ${tenant.schema}.${helper}();`,
        `CREATE FUNCTION ${tenant.schema}.identity_probe() RETURNS text
         LANGUAGE sql SECURITY INVOKER AS $$
           SELECT ${tenant.schema}.${helper}()::text;
         $$;`,
      ]) {
        expect(lintMigration({ ...tenant, sql })).toEqual({ ok: true, errors: [], warnings: [] });
      }
    });
  });

  it.each(identityHelpers)('does not exempt mutation of platform-owned %s from the real linter', (helper) => {
    const tenant = tenantFixtures[0];
    for (const sql of [
      `CREATE OR REPLACE FUNCTION ${helper}() RETURNS text LANGUAGE sql AS $$ SELECT 'forged'; $$;`,
      `ALTER FUNCTION ${tenant.schema}.${helper}() RENAME TO disguised_identity;`,
      `DROP FUNCTION ${tenant.schema}.${helper}();`,
      `ALTER FUNCTION app_owned_function() RENAME TO ${helper};`,
    ]) {
      const result = lintMigration({ ...tenant, sql });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: 'tenant-identity-protected', severity: 'error' }),
      ]));
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