import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { lintMigration } from './migration-linter';
import { listMigrationLifecycle } from './migration-lifecycle';
import { maskSqlIdentifiers, splitSqlStatements } from './migration-sql-text';
import { parseTenantCapabilities } from './tenant-capabilities';
import {
  canonicalMigrationFile, getMigrationWorkspace, migrationReceiptChecksum, recordMigrationFeedback,
  safeMigrationDiagnostic, type MigrationDiagnostic, type MigrationScope, type MigrationWorkspace,
} from './migration-feedback';

export type { MigrationDiagnostic } from './migration-feedback';
export const MIGRATION_POLICY_REVISION = 'static-tenant-v1';
export const migrationDigest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Structural compatibility with historical callers, without importing their review authority. */
export interface MigrationExecutionContext {
  requirementId: string;
  executionGeneration: number;
  instance: { id?: string; site_id: string; user_id?: string; requirement_id: string };
  assertCurrent: () => Promise<void>;
}

export class MigrationExecutionError extends Error {
  constructor(public diagnostic: MigrationDiagnostic, public failureKind: 'product' | 'infrastructure' = 'infrastructure') {
    super(diagnostic.message);
    Object.setPrototypeOf(this, MigrationExecutionError.prototype);
  }
}

export async function assertMigrationExecutionCurrent(context: MigrationExecutionContext): Promise<void> {
  await context.assertCurrent();
  const legacy = await listMigrationLifecycle(context.requirementId);
  // A transferred row is protected by an immutable operator handoff receipt in
  // Makinari. Its pending Apps journal entry still requires real SQL application.
  if (legacy.some(row => row.state !== 'validated' && row.state !== 'transferred')) throw new MigrationExecutionError({
    code: 'LEGACY_MIGRATION_HOLD', kind: 'infrastructure',
    message: 'Historical migration recovery is unresolved. An operator must reconcile it; normal execution cannot release this hold.',
  });
}

/** Reads scope and execution ownership only. Product prose is not an execution credential. */
export async function loadMigrationExecutionContext(requirementId: string, assertOwner?: () => Promise<void>): Promise<MigrationExecutionContext> {
  const load = async () => {
    const { data, error } = await supabaseAdmin.from('requirements')
      .select('id,site_id,user_id,status,metadata').eq('id', requirementId).maybeSingle();
    if (error || !data) throw new Error('Migration requirement context is unavailable.');
    return data;
  };
  await assertOwner?.();
  const original = await load();
  const generation = Number(original.metadata?.requirement_execution_generation ?? 0);
  if (!Number.isSafeInteger(generation) || generation < 0 || !original.site_id || !original.user_id ||
      !['backlog', 'in-progress'].includes(original.status)) throw new Error('Invalid migration execution context.');
  const context: MigrationExecutionContext = {
    requirementId, executionGeneration: generation,
    instance: { id: original.metadata?.runner_instance_id, site_id: original.site_id,
      user_id: original.user_id, requirement_id: requirementId },
    assertCurrent: async () => {
      await assertOwner?.();
      const current = await load();
      if (Number(current.metadata?.requirement_execution_generation ?? 0) !== generation ||
          current.site_id !== original.site_id || current.user_id !== original.user_id ||
          !['backlog', 'in-progress'].includes(current.status)) throw new Error('Migration execution ownership changed.');
    },
  };
  await assertMigrationExecutionCurrent(context);
  return context;
}

export async function loadMigrationTenantScope(context: MigrationExecutionContext): Promise<MigrationScope> {
  const { data, error } = await getAppsAdminClient().from('apps_tenants')
    .select('tenant_id,schema,site_id,user_id,status').eq('requirement_id', context.requirementId).maybeSingle();
  if (error || !data || typeof data.tenant_id !== 'string' || !data.tenant_id ||
      typeof data.schema !== 'string' || !/^app_[a-f0-9]{24}$/.test(data.schema) || data.status !== 'active' ||
      data.site_id !== context.instance.site_id || data.user_id !== context.instance.user_id) {
    throw new Error('Active migration tenant scope is unavailable or changed.');
  }
  // The DB verifies reserved helper definitions/ACLs, not just their names. No Storage probe.
  const capability = await getAppsAdminClient().rpc('apps_get_tenant_capabilities', {
    p_requirement_id: context.requirementId, p_expected_tenant_id: data.tenant_id,
  });
  if (capability.error) throw new Error('Migration tenant capabilities are unavailable.');
  const capabilities = parseTenantCapabilities(capability.data, {
    requirementId: context.requirementId, tenantId: data.tenant_id, schema: data.schema,
  });
  return { schema: data.schema, tenantId: data.tenant_id, capabilityFingerprint: migrationDigest(JSON.stringify(capabilities)) };
}

export function migrationContextKey(context: MigrationExecutionContext, scope: MigrationScope, workspace: MigrationWorkspace): string {
  return migrationDigest(JSON.stringify([MIGRATION_POLICY_REVISION, workspace.schema_fingerprint,
    context.requirementId, context.executionGeneration, context.instance.site_id, context.instance.user_id,
    scope.schema, scope.tenantId, scope.capabilityFingerprint]));
}

/** Copied static application boundary; no model/security-review module in this dependency graph. */
export function isStaticNonDestructiveApplication(sql: string, schema: string): boolean {
  const statements = splitSqlStatements(sql).filter(statement => statement.code.trim());
  if (!statements.length || statements.some(statement => statement.parseError)) return false;
  const identifier = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
  const policyHeader = new RegExp(String.raw`^\s*(create|drop)\s+policy\s+(?:if\s+exists\s+)?(${identifier})\s+on\s+(${identifier})(?:\s*\.\s*(${identifier}))?`, 'i');
  const name = (value: string) => value.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value.toLowerCase();
  const policy = (code: string) => {
    const match = policyHeader.exec(code);
    return match ? { operation: match[1].toLowerCase(), end: match[0].length,
      identity: JSON.stringify([name(match[2]), match[4] ? name(match[3]) : schema, name(match[4] || match[3])]) } : null;
  };
  return statements.every((statement, index) => {
    const code = maskSqlIdentifiers(statement.code);
    if (/^\s*drop\s+policy\b/i.test(code)) {
      const dropped = policy(statement.code);
      return !!dropped && /^\s*(?:restrict\s*)?$/i.test(statement.code.slice(dropped.end)) &&
        statements.slice(index + 1).some(next => {
          const created = policy(next.code);
          return created?.operation === 'create' && created.identity === dropped.identity;
        });
    }
    if (/\b(?:delete\s+from|merge\s+into|truncate|drop)\b|\bupdate\b[\s\S]*\bset\b/i.test(code)) return false;
    return /^\s*(?:create\s+(?:or\s+replace\s+)?(?:(?:unique|unlogged|temporary|temp|materialized|recursive)\s+)?(?:table|index|view|type|sequence|function|procedure|trigger|policy)\b|alter\s+(?:table|index|view|type|sequence|function|procedure|trigger|policy)\b|insert\s+into\b|select\b|with\b|comment\s+on\b)/i.test(code);
  });
}

/** Conservative execution safety, not a proof of arbitrary product authorization semantics. */
export function migrationPolicyDiagnostic(sql: string, scope: MigrationScope, file: string): MigrationDiagnostic | undefined {
  if (!sql.trim() || Buffer.byteLength(sql) > 64 * 1024) return {
    file, code: 'MIGRATION_SQL_BOUNDS', kind: 'policy', message: 'Migration SQL must be nonempty and at most 64 KiB.',
  };
  const lint = lintMigration({ sql, schema: scope.schema, tenant_id: scope.tenantId });
  if (!lint.ok) return safeMigrationDiagnostic({ file, code: 'MIGRATION_LINT', kind: 'policy',
    message: lint.errors.map(error => `${error.rule} (line ${error.line}): ${error.message}`).join('\n') });
  if (!isStaticNonDestructiveApplication(sql, scope.schema)) return {
    file, code: 'MIGRATION_POLICY', kind: 'policy',
    message: 'SQL is outside the automatic static non-destructive boundary. Preserve existing data and intended authorization semantics; use an additive migration or obtain operator review. Do not erase SQL or weaken access policies to pass.',
  };
}

export function migrationFailure(error: unknown, file?: string): { error: string; failureKind: 'product' | 'infrastructure'; diagnostic: MigrationDiagnostic } {
  const diagnostic = safeMigrationDiagnostic(error instanceof MigrationExecutionError ? error.diagnostic : {
    file, code: 'MIGRATION_INFRASTRUCTURE', kind: 'infrastructure',
    message: error instanceof Error ? error.message : 'Migration execution could not be verified.',
  });
  return { error: diagnostic.message, diagnostic,
    failureKind: error instanceof MigrationExecutionError ? error.failureKind : 'infrastructure' };
}

export interface TenantMigrationProposal extends MigrationScope {
  context: MigrationExecutionContext;
  migrationKey: string;
  sql: string;
  assertUnchanged?: () => Promise<void>;
}
export interface TenantMigrationResult {
  applied: boolean;
  error?: string;
  failureKind?: 'product' | 'infrastructure';
  diagnostic?: MigrationDiagnostic;
}

/** A scoped cache notification, not schema exposure/configuration or an SQL receipt. */
export async function reloadTenantMigrationSchema(scope: MigrationScope, file?: string): Promise<void> {
  try {
    const { error } = await getAppsAdminClient().rpc('apps_reload_migration_schema', {
      p_target_schema: scope.schema, p_expected_tenant_id: scope.tenantId,
    });
    if (error) throw new Error('Schema reload unavailable.');
  } catch {
    throw new MigrationExecutionError({ file, code: 'SCHEMA_RELOAD_PENDING', kind: 'infrastructure',
      message: 'The exact SQL application receipt is confirmed, but the API schema reload could not be confirmed. Retry the migration command to request reload without replaying applied SQL.' });
  }
}

/** One bounded attempt, never rewrites SQL. All normal file/platform writes use this authority. */
export async function executeTenantMigration(proposal: TenantMigrationProposal): Promise<TenantMigrationResult> {
  const { context, migrationKey, sql } = proposal;
  const file = migrationKey.slice(10);
  let confirmedApplied = false;
  try {
    if (!migrationKey.startsWith('migration:') || !canonicalMigrationFile(file)) throw new Error('Non-canonical migration key.');
    if (context.requirementId !== context.instance.requirement_id) throw new Error('Migration requirement identity changed.');
    await assertMigrationExecutionCurrent(context);
    const scope = await loadMigrationTenantScope(context);
    if (scope.schema !== proposal.schema || scope.tenantId !== proposal.tenantId) throw new Error('Migration tenant identity changed.');
    const checksum = migrationDigest(sql);
    const workspace = await getMigrationWorkspace(scope);
    const receipt = workspace.receipts.find(row => row.migration_key === migrationKey);
    if (receipt) {
      if (migrationReceiptChecksum(receipt.value) !== checksum) throw new MigrationExecutionError({
        file, code: 'APPLIED_MIGRATION_CHANGED', kind: 'history', message: 'Applied migration bytes are immutable. Restore the exact applied file; never rewrite or backfill the receipt.',
      }, 'product');
      await assertMigrationExecutionCurrent(context);
      await reloadTenantMigrationSchema(scope, file);
      return { applied: false };
    }
    if (workspace.receipts.some(row => migrationReceiptChecksum(row.value) === checksum)) throw new MigrationExecutionError({
      file, code: 'RENAMED_APPLIED_MIGRATION', kind: 'history',
      message: 'These exact SQL bytes already have an applied receipt under another path. Restore the original migration filename; a duplicate or rename is not a new migration.',
    }, 'product');
    if (!sql.trim()) throw new MigrationExecutionError({ file, code: 'EMPTY_MIGRATION', kind: 'policy', message: 'Empty migration cannot erase a pending proposal.' }, 'product');
    const contextKey = migrationContextKey(context, scope, workspace);
    const prior = workspace.files.find(row => row.migration_key === migrationKey);
    const cached = prior?.checksum === checksum && prior.context_key === contextKey && prior.error &&
      (prior.error.kind === 'policy' || prior.error.code === '42601') ? prior.error : undefined;
    if (cached) throw new MigrationExecutionError(safeMigrationDiagnostic({ ...cached, file, repeated: true }), 'product');
    const policy = migrationPolicyDiagnostic(sql, scope, file);
    await recordMigrationFeedback(scope, { migration_key: migrationKey, checksum, context_key: contextKey, error: policy || null });
    if (policy) throw new MigrationExecutionError(policy, 'product');
    await assertMigrationExecutionCurrent(context);
    const freshScope = await loadMigrationTenantScope(context);
    if (freshScope.schema !== scope.schema || freshScope.tenantId !== scope.tenantId ||
        freshScope.capabilityFingerprint !== scope.capabilityFingerprint) throw new Error('Migration tenant identity or capabilities changed.');
    await proposal.assertUnchanged?.();

    let data: unknown;
    let rpcError: { code?: string; message?: string } | undefined;
    try {
      const result = await getAppsAdminClient().rpc('apps_apply_migration', {
        p_target_schema: scope.schema, p_expected_tenant_id: scope.tenantId,
        p_migration_key: migrationKey, p_migration_checksum: checksum, p_migration_sql: sql,
      });
      data = result.data;
      rpcError = result.error || undefined;
    } catch { rpcError = { message: 'Migration transport failed; exact receipt reconciliation is required.' }; }

    // Reconcile even a successful RPC: only immutable durable evidence proves completion.
    const finalWorkspace = await getMigrationWorkspace(scope);
    const finalReceipt = finalWorkspace.receipts.find(row => row.migration_key === migrationKey);
    if (finalReceipt && migrationReceiptChecksum(finalReceipt.value) === checksum) {
      confirmedApplied = data !== false;
      await assertMigrationExecutionCurrent(context);
      await reloadTenantMigrationSchema(scope, file);
      return { applied: confirmedApplied };
    }
    if (finalReceipt) throw new MigrationExecutionError({ file, code: 'APPLIED_MIGRATION_CHANGED', kind: 'history',
      message: 'The migration receipt does not match the proposed bytes. Do not replay SQL or change the receipt.' });
    const code = typeof rpcError?.code === 'string' && /^[0-9A-Z]{5}$/.test(rpcError.code) ? rpcError.code : 'MIGRATION_OUTCOME_UNKNOWN';
    // Only PostgreSQL data/syntax/privilege SQLSTATE errors establish atomic rollback.
    const rolledBack = /^(?:22|23|42)/.test(code);
    const product = rolledBack && code !== '42501';
    const diagnostic = safeMigrationDiagnostic({ file, code, kind: product ? 'sql' : 'infrastructure',
      message: rpcError?.message || 'No exact durable migration receipt was returned. Reconcile before proceeding.',
      ...(rolledBack ? { rolled_back: true } : {}) });
    await recordMigrationFeedback(scope, { migration_key: migrationKey, checksum, context_key: contextKey, error: diagnostic });
    throw new MigrationExecutionError(diagnostic, product ? 'product' : 'infrastructure');
  } catch (error) { return { applied: confirmedApplied, ...migrationFailure(error, file) }; }
}