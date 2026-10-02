import type { Sandbox } from '@vercel/sandbox';
import type { MigrationRepairTarget } from './migration-repair-types';
import {
  assertMigrationExecutionCurrent, executeTenantMigration, loadMigrationExecutionContext, loadMigrationTenantScope,
  migrationContextKey, migrationDigest, MigrationExecutionError, migrationFailure, reloadTenantMigrationSchema,
  type MigrationExecutionContext,
} from './migration-execution';
import {
  canonicalMigrationFile, getMigrationWorkspace, migrationReceiptChecksum, recordMigrationFeedback,
  type MigrationDiagnostic, type MigrationScope, type MigrationWorkspace,
} from './migration-feedback';
import {
  restoreAppliedMigration, verifyMigrationRestorations,
  type MigrationFileRestoration, type MigrationRestorationFailure,
} from './migration-restoration';

export interface MigrationBatchResult {
  applied: string[];
  errors: string[];
  failureKind?: 'product' | 'infrastructure';
  diagnostic?: MigrationDiagnostic;
  pending?: string[];
  /** Retained for historical callers. Normal execution never creates repair/lifecycle assignments. */
  repairTarget?: MigrationRepairTarget;
  restored?: MigrationFileRestoration[];
  restorationFailure?: MigrationRestorationFailure;
}

interface Proposal { file: string; sql: string; checksum: string }
interface Batch {
  context: MigrationExecutionContext;
  scope: MigrationScope;
  proposals: Proposal[];
  workspace: MigrationWorkspace;
}
type RestorationOwner = { assertCurrent: () => Promise<void> };

function refuse(code: string, message: string, kind: MigrationDiagnostic['kind'], file?: string,
  failureKind: 'product' | 'infrastructure' = 'product'): never {
  throw new MigrationExecutionError({ code, message, kind, ...(file ? { file } : {}) }, failureKind);
}

async function readProposal(sandbox: Sandbox, file: string): Promise<Proposal> {
  if (!canonicalMigrationFile(file, false)) refuse('MIGRATION_PATH', 'Non-canonical migration path rejected.', 'history', undefined, 'infrastructure');
  const canonical = await sandbox.runCommand('realpath', ['--', `/vercel/sandbox/${file}`]);
  if (canonical.exitCode !== 0 || (await canonical.stdout()).trim() !== `/vercel/sandbox/${file}`) {
    refuse('MIGRATION_PATH', `Migration ${file} is not a canonical file.`, 'history', file);
  }
  const read = await sandbox.runCommand('cat', [file]);
  if (read.exitCode !== 0) refuse('MIGRATION_READ', `Could not read migration ${file}.`, 'infrastructure', file, 'infrastructure');
  const sql = await read.stdout();
  return { file, sql, checksum: migrationDigest(sql) };
}

async function discover(sandbox: Sandbox): Promise<{ proposals: Proposal[]; tracked: string[] }> {
  const found = await sandbox.runCommand('sh', ['-c',
    'for dir in migrations supabase/migrations src/db/migrations; do ' +
    'if [ -d "$dir" ]; then find "$dir" -name "*.sql" -type f || exit 1; fi; done']);
  if (found.exitCode !== 0) throw new Error('Could not list migration files.');
  const files = (await found.stdout()).split('\n').filter(Boolean).sort();
  if (new Set(files).size !== files.length || files.some(file => !canonicalMigrationFile(file, false))) {
    refuse('MIGRATION_PATH', 'Non-canonical or duplicate migration path rejected.', 'history', undefined, 'infrastructure');
  }
  // Git paths survive a working-tree deletion even before the first journal observation.
  const git = await sandbox.runCommand('git', ['ls-files', '-z', '--', 'migrations', 'supabase/migrations', 'src/db/migrations']);
  if (git.exitCode !== 0) throw new Error('Could not verify tracked migration files.');
  const tracked = (await git.stdout()).split('\0').filter(file => file.endsWith('.sql'));
  // The index omits staged deletions. HEAD remains the committed source of required paths.
  const head = await sandbox.runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.exitCode === 0) {
    const revision = (await head.stdout()).trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('Could not verify committed migration history.');
    const tree = await sandbox.runCommand('git', ['ls-tree', '-r', '-z', '--name-only', revision, '--',
      'migrations', 'supabase/migrations', 'src/db/migrations']);
    if (tree.exitCode !== 0) throw new Error('Could not list committed migration history.');
    tracked.push(...(await tree.stdout()).split('\0').filter(file => file.endsWith('.sql')));
  } else {
    // An explicitly unborn branch is legitimate; missing/corrupt/detached HEAD is not.
    if (head.exitCode !== 1) throw new Error('Could not verify committed migration history.');
    const branch = await sandbox.runCommand('git', ['symbolic-ref', '--quiet', 'HEAD']);
    const ref = (await branch.stdout()).trim();
    if (branch.exitCode !== 0 || !/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(ref)) throw new Error('Could not verify an unborn migration repository.');
    const exists = await sandbox.runCommand('git', ['show-ref', '--verify', '--quiet', ref]);
    if (exists.exitCode !== 1) throw new Error('Could not verify an unborn migration repository.');
  }
  if (tracked.some(file => !canonicalMigrationFile(file, false))) refuse('MIGRATION_PATH', 'Non-canonical tracked migration path rejected.', 'history', undefined, 'infrastructure');
  const proposals: Proposal[] = [];
  for (const file of files) proposals.push(await readProposal(sandbox, file));
  return { proposals, tracked };
}

async function loadBatch(sandbox: Sandbox, requirementId: string, supplied: MigrationExecutionContext | undefined,
  result: MigrationBatchResult, restoration?: RestorationOwner, expectedRepairs: MigrationRepairTarget[] = []): Promise<Batch> {
  const context = supplied || await loadMigrationExecutionContext(requirementId);
  if (context.requirementId !== requirementId || context.instance.requirement_id !== requirementId) throw new Error('Migration requirement identity changed.');
  await assertMigrationExecutionCurrent(context);
  const scope = await loadMigrationTenantScope(context);
  const workspace = await getMigrationWorkspace(scope);
  const { proposals, tracked } = await discover(sandbox);
  const byFile = new Map(proposals.map(proposal => [proposal.file, proposal]));
  const receipts = new Map(workspace.receipts.map(row => [row.migration_key, row]));
  const contextKey = migrationContextKey(context, scope, workspace);

  // Register the whole discovered batch before attempting even its first SQL file.
  // Registering an identical observation must not erase an existing rejection.
  for (const proposal of proposals) {
    if (!proposal.sql.trim() || receipts.has(`migration:${proposal.file}`)) continue;
    const prior = workspace.files.find(row => row.migration_key === `migration:${proposal.file}`);
    if (prior?.checksum === proposal.checksum && prior.context_key === contextKey) continue;
    await assertMigrationExecutionCurrent(context);
    await recordMigrationFeedback(scope, { migration_key: `migration:${proposal.file}`, checksum: proposal.checksum,
      context_key: contextKey, error: null });
  }

  const expected = new Set(tracked);
  for (const row of [...workspace.files, ...workspace.receipts]) {
    const file = row.migration_key.slice(10);
    if (!canonicalMigrationFile(file)) refuse('LEGACY_MIGRATION_RECEIPT', 'An unsupported historical migration key requires operator reconciliation.', 'history', undefined, 'infrastructure');
    if (!file.startsWith('platform/')) expected.add(file);
  }
  for (const repair of expectedRepairs) {
    if (repair.schema !== scope.schema || repair.tenantId !== scope.tenantId) throw new Error('Repaired migration tenant identity changed.');
    expected.add(repair.file);
    if (byFile.get(repair.file)?.checksum !== repair.checksum) throw new Error('A historical repaired migration is missing or changed.');
  }
  for (const file of Array.from(expected)) {
    if (!byFile.has(file)) refuse('MISSING_MIGRATION', `Expected migration ${file} is missing. Restore the file; deleting it cannot satisfy validation.`, 'history', file);
  }
  for (const receipt of workspace.receipts) {
    if (!migrationReceiptChecksum(receipt.value)) refuse('LEGACY_MIGRATION_CHECKSUM', 'An applied migration has no valid checksum. Operator reconciliation is required; normal execution never backfills unproven bytes.', 'history', receipt.migration_key.slice(10), 'infrastructure');
  }
  for (const proposal of proposals) {
    const receipt = receipts.get(`migration:${proposal.file}`);
    const appliedChecksum = receipt && migrationReceiptChecksum(receipt.value);
    if (appliedChecksum && appliedChecksum !== proposal.checksum) {
      if (restoration && supplied?.requirementId === requirementId) {
        const recovery = await restoreAppliedMigration({ sandbox, requirementId, file: proposal.file, ...scope,
          expectedChecksum: appliedChecksum, actualChecksum: proposal.checksum,
          assertCurrent: async () => { await restoration.assertCurrent(); await assertMigrationExecutionCurrent(context); } });
        if ('restored' in recovery) {
          (result.restored ||= []).push(recovery.restored);
          const recovered = await readProposal(sandbox, proposal.file);
          if (recovered.checksum !== appliedChecksum || !recovered.sql.trim()) throw new Error('Restored migration bytes could not be verified.');
          Object.assign(proposal, recovered);
          continue;
        }
        result.restorationFailure = recovery.failure;
        refuse('APPLIED_MIGRATION_CHANGED', `Migration ${proposal.file} changed after it was applied. Exact-byte restoration failed; never change the protected checksum.`,
          'history', proposal.file, recovery.failureKind);
      }
      refuse('APPLIED_MIGRATION_CHANGED', `Migration ${proposal.file} changed after it was applied. Expected SHA-256: ${appliedChecksum}; actual SHA-256: ${proposal.checksum}. Restore exact applied bytes from a trusted source; use a new migration for changes. Never change the protected checksum.`, 'history', proposal.file);
    }
    if (!proposal.sql.trim()) refuse('EMPTY_MIGRATION', `Migration ${proposal.file} is empty; erasing pending or applied SQL cannot satisfy validation.`, 'history', proposal.file);
  }
  return { context, scope, proposals, workspace };
}

function verifyBatch(batch: Batch): void {
  const { workspace, proposals } = batch;
  const receipts = new Map(workspace.receipts.map(row => [row.migration_key, migrationReceiptChecksum(row.value)]));
  const discovered = new Map(proposals.map(row => [row.file, row]));
  for (const row of [...workspace.files, ...workspace.receipts]) {
    const file = row.migration_key.slice(10);
    if (!canonicalMigrationFile(file)) refuse('LEGACY_MIGRATION_RECEIPT', 'An unsupported historical migration key requires operator reconciliation.', 'history', undefined, 'infrastructure');
    if (!file.startsWith('platform/') && !discovered.has(file)) refuse('MISSING_MIGRATION', `Expected migration ${file} is missing.`, 'history', file);
  }
  for (const row of workspace.receipts) {
    const file = row.migration_key.slice(10);
    const checksum = migrationReceiptChecksum(row.value);
    if (!checksum) refuse('LEGACY_MIGRATION_CHECKSUM', 'An applied migration has no valid checksum.', 'history', file, 'infrastructure');
    if (!file.startsWith('platform/') && discovered.get(file)?.checksum !== checksum) refuse('APPLIED_MIGRATION_CHANGED', `Migration ${file} no longer matches its protected receipt.`, 'history', file);
  }
  const pending = new Set<string>();
  for (const proposal of proposals) {
    if (receipts.get(`migration:${proposal.file}`) !== proposal.checksum) pending.add(proposal.file);
  }
  for (const row of workspace.files) {
    if (!receipts.has(row.migration_key)) pending.add(row.migration_key.slice(10));
    // A concurrent proposal may leave different feedback after another proposal commits.
    // The receipt (compared with actual files above), never observation metadata, is truth.
  }
  if (pending.size) {
    const file = Array.from(pending).sort()[0];
    const feedback = workspace.files.find(row => row.migration_key === `migration:${file}`)?.error;
    // A prior transport/permission failure is an observation, not a permanent
    // circuit. Current reads succeeded; allow the agent to retry unchanged SQL
    // through the tool, which will recheck the actual infrastructure and scope.
    if (feedback?.kind === 'infrastructure') throw new MigrationExecutionError({
      file, code: 'MIGRATION_RETRY_REQUIRED', kind: 'pending',
      message: `Migration ${file} still has no application receipt. Previous infrastructure feedback: ${feedback.message} Retry sandbox_db_migrate to recheck the unchanged proposal; do not rewrite SQL to bypass infrastructure or permissions.`,
    }, 'product');
    throw new MigrationExecutionError(feedback || { file, code: 'PENDING_MIGRATIONS', kind: 'pending',
      message: `Unapplied migration proposals remain: ${Array.from(pending).sort().join(', ')}.` },
    'product');
  }
}

function pendingFiles(batch: Batch): string[] {
  const applied = new Set(batch.workspace.receipts.map(row => row.migration_key));
  return Array.from(new Set([...batch.proposals.map(row => `migration:${row.file}`), ...batch.workspace.files.map(row => row.migration_key)]))
    .filter(key => !applied.has(key)).map(key => key.slice(10)).sort();
}

/** No tenant SQL/receipt writes. Observation journal registration still prevents deletion skips. */
export async function verifyPendingMigrations(sandbox: Sandbox, requirementId: string,
  context?: MigrationExecutionContext, restoration?: RestorationOwner): Promise<MigrationBatchResult> {
  const result: MigrationBatchResult = { applied: [], errors: [] };
  try {
    const batch = await loadBatch(sandbox, requirementId, context, result, restoration);
    batch.workspace = await getMigrationWorkspace(batch.scope);
    result.pending = pendingFiles(batch);
    verifyBatch(batch);
    await assertMigrationExecutionCurrent(batch.context);
    if (result.restored?.length) await verifyMigrationRestorations(sandbox, result.restored);
    delete result.pending;
  } catch (error) {
    const failure = migrationFailure(error);
    result.errors.push(failure.error);
    result.failureKind = failure.failureKind;
    result.diagnostic = failure.diagnostic;
  }
  return result;
}

/** Compatible call signature; no normal review/lifecycle writes or Management API work. */
export async function applyPendingMigrations(sandbox: Sandbox, requirementId: string,
  expectedRepairs: MigrationRepairTarget[] = [], applicationContext?: MigrationExecutionContext,
  restoration?: RestorationOwner): Promise<MigrationBatchResult> {
  const result: MigrationBatchResult = { applied: [], errors: [] };
  try {
    const batch = await loadBatch(sandbox, requirementId, applicationContext, result, restoration, expectedRepairs);
    let reloadedHistory = false;
    for (const proposal of batch.proposals) {
      if (batch.workspace.receipts.some(row => row.migration_key === `migration:${proposal.file}`)) {
        // All historical bytes were checked by loadBatch. One reload retries a previous
        // notification failure without rechecking capabilities once per historical file.
        if (!reloadedHistory) {
          await assertMigrationExecutionCurrent(batch.context);
          await reloadTenantMigrationSchema(batch.scope, proposal.file);
          reloadedHistory = true;
        }
        continue;
      }
      const execution = await executeTenantMigration({ context: batch.context, ...batch.scope,
        migrationKey: `migration:${proposal.file}`, sql: proposal.sql,
        assertUnchanged: async () => {
          if ((await readProposal(sandbox, proposal.file)).checksum !== proposal.checksum) throw new Error('Migration changed during validation.');
        } });
      if (execution.applied) result.applied.push(proposal.file);
      if (execution.error) {
        result.errors.push(execution.error);
        result.failureKind = execution.failureKind;
        result.diagnostic = execution.diagnostic;
        result.pending = Array.from(new Set([
          ...batch.proposals.filter(row => !batch.workspace.receipts.some(receipt => receipt.migration_key === `migration:${row.file}`)).map(row => row.file),
          ...batch.workspace.files.filter(row => !batch.workspace.receipts.some(receipt => receipt.migration_key === row.migration_key)).map(row => row.migration_key.slice(10)),
        ])).filter(file => !result.applied.includes(file)).sort();
        return result;
      }
    }
    // Re-discover and re-read the workspace. Missing, new or changed files,
    // including unresolved platform feedback, cannot become an empty success.
    const final = await loadBatch(sandbox, requirementId, batch.context, result, restoration, expectedRepairs);
    final.workspace = await getMigrationWorkspace(final.scope);
    result.pending = pendingFiles(final);
    verifyBatch(final);
    await assertMigrationExecutionCurrent(final.context);
    if (result.restored?.length) await verifyMigrationRestorations(sandbox, result.restored);
    delete result.pending;
  } catch (error) {
    const failure = migrationFailure(error);
    result.errors.push(failure.error);
    result.failureKind = failure.failureKind;
    result.diagnostic = failure.diagnostic;
  }
  return result;
}