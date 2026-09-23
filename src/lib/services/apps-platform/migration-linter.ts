/**
 * SQL Migration Linter for tenant schemas.
 *
 * Validates that user-supplied SQL migrations stay confined to the tenant's
 * own schema and follow the RLS-by-default rule. This is a coarse, lexical
 * linter (not a real SQL parser) — meant to catch the obvious foot-guns that
 * an LLM-generated migration would attempt:
 *   - touching `public.*`, `auth.*`, `storage.*` outside the allowlist;
 *   - dropping or creating other schemas;
 *   - role / extension / search_path manipulation;
 *   - `create table` without an immediate RLS enable + tenant-scoped policy.
 *
 * The output is a list of typed `LintIssue`s with `severity = 'error' |
 * 'warning'`. The migration endpoint refuses to apply when any `error`
 * remains, even after autofix.
 */
import {
  splitSqlStatements,
  type SqlStatement as Statement,
} from './migration-sql-text';

export type LintSeverity = 'error' | 'warning';

export interface LintIssue {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** 1-indexed line of the statement that triggered the rule (best effort). */
  line: number;
}

export interface LintInput {
  /** Tenant schema (e.g. `app_<requirementId>`). */
  schema: string;
  /** Tenant id. No longer strictly required in policies due to dynamic schemas, but kept for context. */
  tenant_id: string;
  /** Optional storage bucket the tenant is allowed to reference. */
  bucket?: string;
  /** Raw SQL — multi-statement allowed, semicolon-separated. */
  sql: string;
}

export interface LintResult {
  ok: boolean;
  errors: LintIssue[];
  warnings: LintIssue[];
}

const FORBIDDEN_TOP_LEVEL = [
  /\bdrop\s+schema\b/i,
  /\bcreate\s+schema\b/i,
  /\balter\s+schema\b/i,
  /\bcreate\s+extension\b/i,
  /\bcreate\s+foreign\s+table\b/i,
  /\balter\s+role\b/i,
  /\bcreate\s+role\b/i,
  /\breset\s+role\b/i,
  /\bset\s+role\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\bdisable\s+row\s+level\s+security\b/i,
  /\bset\s+row_security\b/i,
  /\bsecurity\s+definer\b/i,
  /\bprepare\b/i,
  /^\s*do\b/i,
];

const TENANT_AWARE_PREFIXES = (schema: string): RegExp =>
  new RegExp(
    String.raw`(?:create(?:\s+or\s+replace)?(?:\s+unlogged)?|alter|drop|truncate|comment\s+on)\s+(?:(?:recursive\s+)?view|table|materialized\s+view|function|index|sequence|trigger|policy|type)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?` +
      String.raw`(?:"?(?<schema>[a-zA-Z_][\w]*)"?\.)?"?(?<name>[a-zA-Z_][\w]*)"?`,
    'i',
  );

const PUBLIC_ALLOWLIST = new Set<string>([]);

function checkSchemaScope(stmt: Statement, schema: string, bucket: string | undefined): LintIssue[] {
  const issues: LintIssue[] = [];
  const re = TENANT_AWARE_PREFIXES(schema);
  let match: RegExpExecArray | null;
  const reGlobal = new RegExp(re.source, 'gi');
  while ((match = reGlobal.exec(stmt.code)) !== null) {
    const targetSchema = (match.groups?.schema || '').toLowerCase();
    const targetName = (match.groups?.name || '').toLowerCase();
    if (!targetSchema || targetSchema === schema.toLowerCase()) continue;
    if (targetSchema === 'public' && PUBLIC_ALLOWLIST.has(targetName)) continue;
    if (targetSchema === 'storage' && bucket && targetName === bucket) continue;
    issues.push({
      rule: 'schema-scope',
      severity: 'error',
      line: stmt.line,
      message: `Statement targets schema "${targetSchema}.${targetName}" — only "${schema}.*" is allowed.`,
    });
  }
  const dataReference = /\b(?:insert\s+into|update|delete\s+from|merge\s+into|copy|from|join|references)\s+(?:"?([a-zA-Z_][\w]*)"?\.)"?([a-zA-Z_][\w]*)"?/gi;
  while ((match = dataReference.exec(stmt.code)) !== null) {
    const targetSchema = (match[1] || '').toLowerCase();
    const targetName = (match[2] || '').toLowerCase();
    if (!targetSchema || targetSchema === schema.toLowerCase()) continue;
    issues.push({
      rule: 'schema-scope',
      severity: 'error',
      line: stmt.line,
      message: `Statement references schema "${targetSchema}.${targetName}" — only "${schema}.*" is allowed.`,
    });
  }
  return issues;
}

function checkAuthAndStorage(stmt: Statement, bucket: string | undefined): LintIssue[] {
  const issues: LintIssue[] = [];
  if (/\bauth\.users\b/i.test(stmt.code)) {
    issues.push({
      rule: 'auth-users-forbidden',
      severity: 'error',
      line: stmt.line,
      message: 'Direct reference to auth.users is forbidden. Use public.tenant_users via Platform API instead.',
    });
  }
  const storageMatches = stmt.code.match(/\bstorage\.[a-zA-Z_]+\b/gi) ?? [];
  for (const m of storageMatches) {
    const target = m.split('.')[1].toLowerCase();
    if (bucket && target === bucket) continue;
    if (target === 'objects' || target === 'buckets') {
      issues.push({
        rule: 'storage-scope',
        severity: 'error',
        line: stmt.line,
        message: `Storage table "${m}" cannot be referenced — bucket policies are managed by tenant-provisioner.`,
      });
    }
  }
  return issues;
}

function checkSearchPath(stmt: Statement, schema: string): LintIssue[] {
  if (/\bset_config\s*\(/i.test(stmt.code)) {
    return [{
      rule: 'search-path',
      severity: 'error',
      line: stmt.line,
      message: 'set_config() is forbidden in tenant migrations.',
    }];
  }
  const m = stmt.code.match(/\bset\s+search_path\s*(?:=|to)\s*([^;]+)/i);
  if (!m) return [];
  const parts = m[1]
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, '').toLowerCase());
  const allowed = new Set([schema.toLowerCase(), 'pg_catalog', 'pg_temp']);
  const bad = parts.filter((p) => p && !allowed.has(p));
  if (bad.length === 0) return [];
  return [
    {
      rule: 'search-path',
      severity: 'error',
      line: stmt.line,
      message: `set search_path includes foreign schemas: ${bad.join(', ')}.`,
    },
  ];
}

function checkRlsAfterCreateTable(
  statements: Statement[],
  schema: string,
  tenant_id: string,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const tableRe = /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?/i;
  const enableRlsRe = /\balter\s+table\s+(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?\s+enable\s+row\s+level\s+security/i;
  // `[^;]` already matches newlines (dotAll is NOT needed for a negated class).
  // Removing the `/s` flag keeps this ES2015-compatible.
  const policyRe = /\bcreate\s+policy\s+[^;]*?on\s+(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?/i;

  const seenTables: Array<{ name: string; line: number }> = [];
  for (const stmt of statements) {
    const m = tableRe.exec(stmt.code);
    if (!m) continue;
    const sch = (m[1] || schema).toLowerCase();
    if (sch !== schema.toLowerCase()) continue;
    seenTables.push({ name: m[2].toLowerCase(), line: stmt.line });
  }

  if (seenTables.length === 0) return issues;

  const enabledRls = new Set<string>();
  const policiedTables = new Set<string>();
  for (const stmt of statements) {
    const e = enableRlsRe.exec(stmt.code);
    if (e) {
      const sch = (e[1] || schema).toLowerCase();
      if (sch === schema.toLowerCase()) enabledRls.add(e[2].toLowerCase());
    }
    const p = policyRe.exec(stmt.code);
    if (p) {
      const sch = (p[1] || schema).toLowerCase();
      if (sch === schema.toLowerCase()) policiedTables.add(p[2].toLowerCase());
    }
  }
  void tenant_id;

  for (const t of seenTables) {
    if (!enabledRls.has(t.name)) {
      issues.push({
        rule: 'rls-required',
        severity: 'error',
        line: t.line,
        message: `Table "${schema}.${t.name}" must enable row level security in the same migration.`,
      });
    }
    if (!policiedTables.has(t.name)) {
      issues.push({
        rule: 'tenant-policy-required',
        severity: 'error',
        line: t.line,
        message: `Table "${schema}.${t.name}" should declare a policy. Make sure to use auth.uid() or role-based logic for RLS.`,
      });
    }
  }
  return issues;
}

function checkTopLevelForbidden(stmt: Statement): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const re of FORBIDDEN_TOP_LEVEL) {
    if (re.test(stmt.code)) {
      issues.push({
        rule: 'forbidden-statement',
        severity: 'error',
        line: stmt.line,
        message: `Statement matches forbidden pattern ${re.source}. Tenants cannot mutate schemas, roles, extensions or grants.`,
      });
    }
  }
  return issues;
}

function checkDynamicSchemaEscape(stmt: Statement): LintIssue[] {
  const unsafePatterns = [
    /\binformation_schema\.schemata\b/i,
    /\bpg_namespace\b/i,
    /\bexecute\b(?!\s+(?:function|procedure)\b)/i,
    /\bschema_name\s+like\s+['"]app[_%]/i,
  ];
  if (!unsafePatterns.some((pattern) => pattern.test(stmt.code))) return [];
  return [{
    rule: 'dynamic-schema-scope',
    severity: 'error',
    line: stmt.line,
    message:
      'Tenant migrations cannot enumerate schemas or execute dynamic DDL. ' +
      'Use unqualified objects; the migration runner already sets the tenant search_path.',
  }];
}

function checkQualifiedFunctionCalls(
  stmt: Statement,
  schema: string,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const allowedAuthFunctions = new Set(['email', 'jwt', 'role', 'uid']);
  const qualifiedCall =
    /"?([a-zA-Z_][\w]*)"?\s*\.\s*"?([a-zA-Z_][\w]*)"?\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = qualifiedCall.exec(stmt.code)) !== null) {
    const targetSchema = match[1].toLowerCase();
    const functionName = match[2].toLowerCase();
    if (targetSchema === schema.toLowerCase()) continue;
    if (
      targetSchema === 'auth' &&
      allowedAuthFunctions.has(functionName)
    ) {
      continue;
    }
    issues.push({
      rule: 'qualified-function-scope',
      severity: 'error',
      line: stmt.line,
      message:
        `Calling "${targetSchema}.${functionName}()" is not allowed in a ` +
        'tenant migration. Use unqualified safe built-ins or a function in ' +
        `the "${schema}" schema.`,
    });
  }
  return issues;
}

function checkOnTargetScope(
  stmt: Statement,
  schema: string,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const qualifiedTarget =
    String.raw`(?:only\s+)?"?([a-zA-Z_][\w]*)"?\s*\.\s*"?([a-zA-Z_][\w]*)"?`;
  const patterns = [
    new RegExp(
      String.raw`\bcreate\s+(?:unique\s+)?index\b[\s\S]*?\bon\s+${qualifiedTarget}`,
      'gi',
    ),
    new RegExp(
      String.raw`\b(?:create|alter|drop)\s+(?:policy|trigger)\b[\s\S]*?\bon\s+${qualifiedTarget}`,
      'gi',
    ),
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stmt.code)) !== null) {
      const targetSchema = match[1].toLowerCase();
      const targetName = match[2].toLowerCase();
      if (targetSchema === schema.toLowerCase()) continue;
      issues.push({
        rule: 'schema-scope',
        severity: 'error',
        line: stmt.line,
        message:
          `Statement targets schema "${targetSchema}.${targetName}" — ` +
          `only "${schema}.*" is allowed.`,
      });
    }
  }
  return issues;
}

function checkRoutineSafety(stmt: Statement): LintIssue[] {
  if (
    !/\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i.test(
      stmt.code,
    )
  ) {
    return [];
  }
  if (/\bas\s+(?:e|u&)?'/i.test(stmt.code)) {
    return [{
      rule: 'routine-body-format',
      severity: 'error',
      line: stmt.line,
      message:
        'Routine bodies must use dollar quoting so their executable SQL can be audited.',
    }];
  }
  return [];
}

function checkTableCreationEscape(stmt: Statement): LintIssue[] {
  if (
    /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i.test(
      stmt.code,
    )
  ) {
    return [];
  }
  if (
    !/\bselect\b[\s\S]*?\binto\s+(?:temporary\s+|temp\s+|unlogged\s+)?(?:table\s+)?/i
      .test(stmt.code)
  ) {
    return [];
  }
  return [{
    rule: 'rls-required',
    severity: 'error',
    line: stmt.line,
    message:
      'SELECT INTO table creation is not allowed. Use CREATE TABLE with RLS and policies.',
  }];
}

function checkViewSafety(stmt: Statement): LintIssue[] {
  if (/\bcreate\s+materialized\s+view\b/i.test(stmt.code)) {
    return [{
      rule: 'rls-view-safety',
      severity: 'error',
      line: stmt.line,
      message:
        'Materialized views are not allowed because they can expose rows outside caller RLS.',
    }];
  }
  if (
    /\bcreate\s+(?:or\s+replace\s+)?(?:recursive\s+)?view\b/i.test(
      stmt.code,
    ) &&
    !/\bwith\s*\([^)]*\bsecurity_invoker\s*=\s*true\b[^)]*\)/i.test(
      stmt.code,
    )
  ) {
    return [{
      rule: 'rls-view-safety',
      severity: 'error',
      line: stmt.line,
      message:
        'Views must declare WITH (security_invoker = true) so caller RLS applies.',
    }];
  }
  if (
    /\balter\s+view\b/i.test(stmt.code) &&
    /\bsecurity_invoker\b/i.test(stmt.code) &&
    !/\bset\s*\([^)]*\bsecurity_invoker\s*=\s*true\b[^)]*\)/i.test(
      stmt.code,
    )
  ) {
    return [{
      rule: 'rls-view-safety',
      severity: 'error',
      line: stmt.line,
      message: 'Tenant views cannot disable security_invoker.',
    }];
  }
  return [];
}

function policyPredicates(code: string): string[] {
  const predicates: string[] = [];
  const predicateStart = /\b(?:using|with\s+check)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = predicateStart.exec(code)) !== null) {
    const start = predicateStart.lastIndex;
    let depth = 1;
    let end = start;
    while (end < code.length && depth > 0) {
      if (code[end] === '(') depth++;
      else if (code[end] === ')') depth--;
      end++;
    }
    if (depth === 0) predicates.push(code.slice(start, end - 1).trim());
    predicateStart.lastIndex = end;
  }
  return predicates;
}

function isUnconditionalPolicyPredicate(predicate: string): boolean {
  const normalized = predicate.replace(/\s+/g, ' ').trim();
  const tautology =
    String.raw`(?:true|1\s*=\s*1|auth\.uid\s*\(\s*\)\s+is\s+not\s+null|` +
    String.raw`auth\.uid\s*\(\s*\)\s*=\s*auth\.uid\s*\(\s*\))`;
  const wrappedTautology = String.raw`\(*\s*${tautology}\s*\)*`;
  return new RegExp(`^${wrappedTautology}$`, 'i').test(normalized) ||
    new RegExp(`(?:^|\\()\\s*${wrappedTautology}\\s+or\\b`, 'i')
      .test(normalized) ||
    new RegExp(`\\bor\\s+${wrappedTautology}\\s*(?:$|\\))`, 'i')
      .test(normalized);
}

function checkPermissiveAuthenticatedPolicy(stmt: Statement): LintIssue[] {
  const isCreate = /\bcreate\s+policy\b/i.test(stmt.code);
  const isAlter = /\balter\s+policy\b/i.test(stmt.code);
  if (!isCreate && !isAlter) return [];
  const predicates = policyPredicates(stmt.code);
  const unconditional = predicates.some(isUnconditionalPolicyPredicate);
  if (!unconditional && (!isCreate || predicates.length > 0)) return [];
  return [{
    rule: 'permissive-authenticated-policy',
    severity: 'error',
    line: stmt.line,
    message:
      'RLS policy grants unconditional access to authenticated users. ' +
      'Scope access with auth.uid(), tenant membership, or another row ownership predicate.',
  }];
}

function checkMigrationInfrastructureMutation(stmt: Statement): LintIssue[] {
  if (!/\b(?:_meta|_execute_tenant_migration)\b/i.test(stmt.code)) return [];
  return [{
    rule: 'migration-ledger-protected',
    severity: 'error',
    line: stmt.line,
    message:
      'Tenant migrations cannot read or mutate protected migration infrastructure.',
  }];
}

export function lintMigration(input: LintInput): LintResult {
  const { sql, schema, tenant_id, bucket } = input;
  const statements = splitSqlStatements(sql);
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  for (const stmt of statements) {
    errors.push(...checkTopLevelForbidden(stmt));
    errors.push(...checkSchemaScope(stmt, schema, bucket));
    errors.push(...checkAuthAndStorage(stmt, bucket));
    errors.push(...checkSearchPath(stmt, schema));
    errors.push(...checkDynamicSchemaEscape(stmt));
    errors.push(...checkQualifiedFunctionCalls(stmt, schema));
    errors.push(...checkOnTargetScope(stmt, schema));
    errors.push(...checkRoutineSafety(stmt));
    errors.push(...checkTableCreationEscape(stmt));
    errors.push(...checkViewSafety(stmt));
    errors.push(...checkPermissiveAuthenticatedPolicy(stmt));
    errors.push(...checkMigrationInfrastructureMutation(stmt));
  }
  errors.push(...checkRlsAfterCreateTable(statements, schema, tenant_id));

  return { ok: errors.length === 0, errors, warnings };
}
