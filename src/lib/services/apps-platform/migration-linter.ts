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
  /** Tenant id, must match `auth.jwt()->>'tenant_id'` in policies. */
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

interface Statement {
  text: string;
  line: number;
}

function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let buf = '';
  let line = 1;
  let startLine = 1;
  let inLineComment = false;
  let inBlockComment = false;
  let inString: '"' | "'" | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '\n') line++;

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      buf += ch;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        buf += '*/';
        i++;
      } else {
        buf += ch;
      }
      continue;
    }
    if (inString) {
      buf += ch;
      if (ch === inString && sql[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === '-' && next === '-') {
      inLineComment = true;
      buf += '--';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      buf += '/*';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      buf += ch;
      continue;
    }
    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed) out.push({ text: trimmed, line: startLine });
      buf = '';
      startLine = line;
      continue;
    }
    if (!buf.trim() && /\s/.test(ch)) {
      if (ch === '\n') startLine = line + 1;
      else startLine = line;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push({ text: tail, line: startLine });
  return out;
}

const FORBIDDEN_TOP_LEVEL = [
  /\bdrop\s+schema\b/i,
  /\bcreate\s+schema\b/i,
  /\bcreate\s+extension\b/i,
  /\balter\s+role\b/i,
  /\bcreate\s+role\b/i,
  /\breset\s+role\b/i,
  /\bset\s+role\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
];

const TENANT_AWARE_PREFIXES = (schema: string): RegExp =>
  new RegExp(
    String.raw`(?:create|alter|drop|truncate|comment\s+on)\s+(table|view|materialized\s+view|function|index|sequence|trigger|policy|type)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?` +
      String.raw`(?:"?(?<schema>[a-zA-Z_][\w]*)"?\.)?"?(?<name>[a-zA-Z_][\w]*)"?`,
    'i',
  );

const PUBLIC_ALLOWLIST = new Set<string>([]);

function checkSchemaScope(stmt: Statement, schema: string, bucket: string | undefined): LintIssue[] {
  const issues: LintIssue[] = [];
  const re = TENANT_AWARE_PREFIXES(schema);
  let match: RegExpExecArray | null;
  const reGlobal = new RegExp(re.source, 'gi');
  while ((match = reGlobal.exec(stmt.text)) !== null) {
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
  return issues;
}

function checkAuthAndStorage(stmt: Statement, bucket: string | undefined): LintIssue[] {
  const issues: LintIssue[] = [];
  if (/\bauth\.users\b/i.test(stmt.text)) {
    issues.push({
      rule: 'auth-users-forbidden',
      severity: 'error',
      line: stmt.line,
      message: 'Direct reference to auth.users is forbidden. Use public.tenant_users via Platform API instead.',
    });
  }
  const storageMatches = stmt.text.match(/\bstorage\.[a-zA-Z_]+\b/gi) ?? [];
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
  const m = stmt.text.match(/\bset\s+search_path\s*=\s*([^;]+)/i);
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
  const tableRe = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?/i;
  const enableRlsRe = /\balter\s+table\s+(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?\s+enable\s+row\s+level\s+security/i;
  // `[^;]` already matches newlines (dotAll is NOT needed for a negated class).
  // Removing the `/s` flag keeps this ES2015-compatible.
  const policyRe = /\bcreate\s+policy\s+[^;]*?on\s+(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?[^;]*?auth\.jwt\(\)\s*->>\s*'tenant_id'/i;

  const seenTables: Array<{ name: string; line: number }> = [];
  for (const stmt of statements) {
    const m = tableRe.exec(stmt.text);
    if (!m) continue;
    const sch = (m[1] || schema).toLowerCase();
    if (sch !== schema.toLowerCase()) continue;
    seenTables.push({ name: m[2].toLowerCase(), line: stmt.line });
  }

  if (seenTables.length === 0) return issues;

  const enabledRls = new Set<string>();
  const policiedTables = new Set<string>();
  for (const stmt of statements) {
    const e = enableRlsRe.exec(stmt.text);
    if (e) {
      const sch = (e[1] || schema).toLowerCase();
      if (sch === schema.toLowerCase()) enabledRls.add(e[2].toLowerCase());
    }
    const p = policyRe.exec(stmt.text);
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
        message: `Table "${schema}.${t.name}" must declare a policy referencing auth.jwt()->>'tenant_id'.`,
      });
    }
  }
  return issues;
}

function checkTopLevelForbidden(stmt: Statement): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const re of FORBIDDEN_TOP_LEVEL) {
    if (re.test(stmt.text)) {
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

export function lintMigration(input: LintInput): LintResult {
  const { sql, schema, tenant_id, bucket } = input;
  const statements = splitStatements(sql);
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  for (const stmt of statements) {
    errors.push(...checkTopLevelForbidden(stmt));
    errors.push(...checkSchemaScope(stmt, schema, bucket));
    errors.push(...checkAuthAndStorage(stmt, bucket));
    errors.push(...checkSearchPath(stmt, schema));
  }
  errors.push(...checkRlsAfterCreateTable(statements, schema, tenant_id));

  return { ok: errors.length === 0, errors, warnings };
}
