import { createHash } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { adaptAssistantWorkspace, WorkspaceError, WORKSPACE_ROOT, workspaceNetworkPolicy } from '@/lib/harness/workspace';
import { WORKSPACE_ISOLATION_VERSION, WORKSPACE_ROOT_INIT } from '@/lib/harness/workspace-process-guard';
import { resolveSandboxAuth } from '@/lib/harness/sandbox-auth';
import { registerSandboxBilling, reconcileSandboxBilling, reconcileSandboxBillingQuiet } from '@/lib/services/billing/sandbox-billing';
import { SANDBOX_SNAPSHOT_TTL_MS } from '@/lib/services/sandbox-constants';
import type { AssistantWorkspaceScope, AssistantWorkspaceSource } from './workspace-source';

export const INSTANCE_WORKSPACE_PREFIX = 'a-';
const fail = (code: string, message: string): never => { throw new WorkspaceError(code, message, false); };
const isMissing = (error: unknown) => !!error && typeof error === 'object' &&
  'response' in error && (error.response as { status?: number })?.status === 404;

export class AssistantWorkspaceOpenError extends WorkspaceError {
  constructor(code: string, message: string, readonly safeToRelease: boolean) { super(code, message, false); }
}

/** No source resume, snapshot, origin edit, policy update, or source script execution.
 * Managed work is inspected from an exact saved revision in an isolated copy.
 */
export async function openAssistantWorkspace(input: {
  scope: AssistantWorkspaceScope; source: AssistantWorkspaceSource; initialized: boolean;
  assertActive(): Promise<void>; signal: AbortSignal;
  recordResource(name: string): Promise<void>;
  assertCleanup(): Promise<void>;
}) {
  const { scope, source, assertActive, signal } = input;
  const auth = resolveSandboxAuth();
  let sourceSnapshot: string | undefined;
  if (source.kind !== 'instance') {
    await assertActive();
    let original: Sandbox;
    try { original = await Sandbox.get({ ...auth, name: source.sandboxName, resume: false, signal }); }
    catch { return fail('WORKSPACE_SOURCE_UNAVAILABLE', 'The saved requirement workspace could not be inspected. No replacement workspace was created.'); }
    await assertActive();
    if (original.tags?.harnessIsolation !== WORKSPACE_ISOLATION_VERSION) {
      return fail('WORKSPACE_ISOLATION_REQUIRED', 'This source workspace predates process isolation. Its files were preserved; safe host migration is required before snapshot inspection.');
    }
    sourceSnapshot = original.currentSnapshotId;
    if (!sourceSnapshot) return fail('WORKSPACE_SNAPSHOT_UNAVAILABLE', 'The requirement workspace has no saved snapshot available for safe inspection. No source was restarted or replaced.');
  }
  const name = sourceSnapshot
    ? `ai-${createHash('sha256').update(JSON.stringify([scope.instanceId, sourceSnapshot])).digest('hex').slice(0, 40)}`
    : `${INSTANCE_WORKSPACE_PREFIX}${scope.instanceId}`;
  const tags = { assistantInstance: scope.instanceId, assistantSite: scope.siteId,
    harnessIsolation: WORKSPACE_ISOLATION_VERSION, assistantSourceSnapshot: sourceSnapshot ?? 'empty' };
  let sandbox: Sandbox | undefined;
  let created = false;
  let providerAdmission = false;
  try {
    await assertActive();
    // Missing migration fails here, before allocating a VM. Never unbilled fallback.
    await registerSandboxBilling(name, { kind: 'instance', id: scope.instanceId, siteId: scope.siteId });
    await input.recordResource(name);
    await assertActive();
    try { sandbox = await Sandbox.get({ ...auth, name, resume: false, signal }); }
    catch (error) {
      if (!isMissing(error)) throw error;
      if (!sourceSnapshot && input.initialized) return fail('WORKSPACE_MISSING', 'The previously created workspace is unavailable. It was not replaced with an empty directory.');
      await assertActive();
      providerAdmission = true;
      sandbox = await Sandbox.create({ ...auth, name, persistent: true,
        ...(sourceSnapshot ? { source: { type: 'snapshot' as const, snapshotId: sourceSnapshot } } : { image: 'vercel/sandbox/universal' }),
        timeout: 180_000, env: {}, ports: [], networkPolicy: sourceSnapshot ? 'deny-all' : workspaceNetworkPolicy(), tags,
        snapshotExpiration: sourceSnapshot ? SANDBOX_SNAPSHOT_TTL_MS : 0,
        keepLastSnapshots: { count: 1, deleteEvicted: true, expiration: sourceSnapshot ? SANDBOX_SNAPSHOT_TTL_MS : 0 }, signal });
      created = true;
    }
    await assertActive();
    if (sandbox.name !== name || !sandbox.persistent || Object.entries(tags).some(([key, value]) => sandbox!.tags?.[key] !== value)) {
      sandbox = undefined; // A foreign handle is never stopped or adopted.
      return fail('WORKSPACE_SCOPE_MISMATCH', 'Existing workspace identity differs from this instance; no files were changed.');
    }
    if (!created && ['stopped', 'failed', 'aborted'].includes(sandbox.status) && !sandbox.currentSnapshotId) {
      return fail('WORKSPACE_SNAPSHOT_MISSING', 'The workspace has no restorable snapshot; it was not restarted empty.');
    }
    if (!created && sandbox.tags?.assistantReady !== 'true') {
      return fail('WORKSPACE_NOT_READY', 'Workspace initialization was interrupted. Existing files were preserved for recovery.');
    }
    if (['stopping', 'snapshotting', 'pending'].includes(sandbox.status)) {
      return fail('WORKSPACE_BUSY', 'Workspace is changing state; retry after the current operation finishes.');
    }
    await reconcileSandboxBilling(sandbox);
    await assertActive();
    providerAdmission = true;
    sandbox = await Sandbox.get({ ...auth, name, resume: true, signal,
      onResume: async resumed => { await assertActive(); await reconcileSandboxBilling(resumed); } });
    await assertActive();
    if (created && !sourceSnapshot) {
      const initialized = await sandbox.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', WORKSPACE_ROOT_INIT],
        cwd: '/', env: {}, sudo: true, timeoutMs: 10000, signal });
      await assertActive();
      if (initialized.exitCode !== 0) return fail('WORKSPACE_NOT_READY', 'The private workspace root could not be initialized.');
    }
    if (created) {
      // Inspection copies must already have the isolated source layout. Never chown them.
      await sandbox.update({ tags: { ...tags, assistantReady: 'true' } }, { signal });
      await assertActive();
    }
    const owned = sandbox;
    const workspace = adaptAssistantWorkspace(owned, assertActive, signal, !!sourceSnapshot, input.assertCleanup);
    return { workspace, source: sourceSnapshot ? {
      kind: source.kind === 'workflow' ? 'workflow_snapshot' : 'requirement_snapshot', snapshotId: sourceSnapshot,
      notice: 'Read-only saved snapshot. It may not include unsaved changes from the active source. Its owner was not resumed.',
    } : { kind: 'instance_workspace', root: WORKSPACE_ROOT, notice: 'Private persistent workspace for this instance; no requirement or plan was created.' },
    async close() {
      // Inspection copies never keep source-derived data/processes running.
      // Private instance work can keep a background process until the provider's
      // bounded session timeout; subsequent calls reconnect to that same session.
      if (sourceSnapshot) { await input.assertCleanup(); await owned.stop({ signal: AbortSignal.timeout(60_000) }); }
      await reconcileSandboxBillingQuiet(owned);
    } };
  } catch (error) {
    let stopped = false;
    if (sandbox) {
      try { await input.assertCleanup(); await sandbox.stop({ signal: AbortSignal.timeout(60_000) }); stopped = true; } catch { /* Unknown cleanup outcome or a newer owner. */ }
      await reconcileSandboxBillingQuiet(sandbox);
    }
    throw new AssistantWorkspaceOpenError(error instanceof WorkspaceError ? error.code : 'WORKSPACE_UNAVAILABLE',
      error instanceof WorkspaceError ? error.message : 'Workspace connection or billing is unavailable. No empty replacement or requirement restart was performed.',
      !providerAdmission || stopped);
  }
}