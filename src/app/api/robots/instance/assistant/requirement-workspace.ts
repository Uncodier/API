import { randomUUID } from 'node:crypto';
import type { Sandbox } from '@vercel/sandbox';
import { runRequirementAssistantSlice } from './requirement-session';
import { createSessionStore } from '@/lib/harness/store';
import { openWorkspace, replaceWorkspaceEnvironment, suspendWorkspaceForCleanup } from '@/lib/harness/workspace';
import { claimSandboxCleanup } from '@/lib/services/billing/sandbox-cleanup-fence';
import { RequirementCreditsExhaustedError } from '@/lib/services/billing/openrouter-usage-billing';
import { createWorkspaceTools } from '@/lib/harness/workspace-tools';
import { createCapabilityTools, refreshTenantEnvironment } from '@/lib/harness/capabilities';
import { createDeliveryTools } from '@/lib/harness/delivery-tools';
import { createArchiveTool } from '@/lib/harness/archive-tool';
import { resolveHostProfile } from '@/lib/harness/profile';
import { createRedactor, runtimeSecretValues, safeError } from '@/lib/harness/security';
import { createHostStateStore } from '@/lib/harness/host-state-store';
import { createArtifactStore } from '@/lib/harness/artifact-store';
import { loadSessionConfiguration } from '@/lib/harness/host-configuration';
import { withinDeadline } from '@/lib/harness/deadline';
import { workspaceOpenRequiresOperator } from '@/lib/harness/workspace-open-failure';
import type { HarnessTool, SessionScope, Workspace } from '@/lib/harness/types';
import type { RequirementRun } from '@/lib/harness/requirement-types';
import { writeRequirementInstanceLog } from './requirement-instance-log';
import { assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import type { HostProfile } from '@/lib/harness/profile';

export interface SessionRuntimeOptions {
  /** Trusted cron adapter, never deserialized from model arguments or public request JSON. */
  profile?: HostProfile;
  assertExecution?: () => Promise<void>;
  /** Same run/generation identity, but permits terminal sessions for owned cleanup only. */
  assertCleanup: () => Promise<void>;
  context?: string;
  /** Trusted host callback, not public/model input. Same advisory contract as the engine. */
  getContext?: () => Promise<string>;
  tools?: (workspace: Workspace, host: Awaited<ReturnType<typeof loadSessionConfiguration>>) => Promise<HarnessTool[]>;
  openWorkspace?: (input: Parameters<typeof openWorkspace>[0]) => Promise<Workspace>;
  checkpoint?: (input: { workspace: Workspace; redact: (text: string) => string;
    owner: string; assertActive: () => Promise<void>; signal: AbortSignal }) => Promise<void>;
  cronRun: RequirementRun;
}

/** Durable transport calls this function. Nothing here classifies product tasks or runs quality gates. */
export async function executeRequirementAssistantWorkspace(id: string, scope: SessionScope, options: SessionRuntimeOptions): Promise<{ status: string; continue: boolean }> {
  if (!options.assertExecution || !options.assertCleanup || options.cronRun.sessionId !== id || options.cronRun.siteId !== scope.siteId || options.cronRun.userId !== scope.userId) {
    throw new Error('Requirement assistant execution scope mismatch');
  }
  await options.assertExecution?.();
  const store = createSessionStore();
  const owner = randomUUID();
  let session = await store.claim(id, scope.siteId, owner, 300);
  if (!session) return { status: 'not_claimed', continue: false };
  const knownSecrets = new Set<string>();
  let currentHost: Awaited<ReturnType<typeof loadSessionConfiguration>> | undefined;
  const redact = (text: string) => createRedactor([...knownSecrets, ...(currentHost?.configuration.redactionValues || [])])(text);
  // Bound each transport slice, not the cumulative lifetime of the session.
  const deadline = AbortSignal.timeout(210000);
  let workspace;
  let ownedHandle: Sandbox | undefined;
  const setupStarted = Date.now();
  let setupAccounted = false;
  const assertActive = async () => {
    deadline.throwIfAborted();
    await options.assertExecution?.();
    await store.assertOwner(id, scope.siteId, owner, 300);
  };
  const accountSetup = async () => {
    if (setupAccounted) return;
    const current = await store.load(id, scope.siteId);
    if (current?.status === 'running') {
      current.activeMs += Math.max(0, Date.now() - setupStarted);
      session = await store.save(current, scope.siteId, owner);
    }
    setupAccounted = true;
  };
  try {
    await assertToolScreenAccess('read_files', { siteId: scope.siteId, userId: scope.userId });
    console.info('[Requirement assistant] Preparing owned workspace.');
    const host = await loadSessionConfiguration(createHostStateStore(), { id, siteId: scope.siteId, owner });
    currentHost = host;
    host.configuration.redactionValues.forEach(value => knownSecrets.add(value));
    const profile = options.profile || resolveHostProfile(session.request.profile, scope.siteId, session.request.repository.url);
    if (profile && profile.userId !== scope.userId) throw new Error('Profile owner changed');
    if (profile?.git) knownSecrets.add(profile.git.password);
    if (profile?.deployment) {
      knownSecrets.add(profile.deployment.token);
      if (profile.deployment.deployHookUrl) knownSecrets.add(profile.deployment.deployHookUrl);
    }
    runtimeSecretValues(profile?.environment || {}).forEach(value => knownSecrets.add(value));
    await assertActive();
    await host.setLayer('profile', { values: profile?.environment || {} }, [...knownSecrets]);
    for (const [name, layer] of Object.entries(host.configuration.layers)) {
      if (layer.refresh && layer.refresh.requirementId !== profile?.requirementId) {
        throw new Error('Runtime tenant configuration binding changed');
      }
      if (layer.refresh && layer.expiresAt && Date.parse(layer.expiresAt) <= Date.now() + 120000) {
        try {
          const refreshed = await withinDeadline(deadline, () => refreshTenantEnvironment(layer.refresh!.requirementId, scope, assertActive, options.cronRun));
          await host.setLayer(name, { ...layer, values: { ...layer.values, ...refreshed.values }, expiresAt: refreshed.expiresAt });
        } catch {
          // An unavailable DB refresh must not prevent unrelated repository work.
          // Retain the refresh reference and redaction history, omit expired app credentials.
          await host.setLayer(name, { ...layer, values: Object.fromEntries(Object.entries(layer.values)
            .filter(([key]) => !/(?:JWT|TOKEN|PASSWORD|SECRET)/i.test(key))) });
        }
      }
    }
    host.configuration.redactionValues.forEach(value => knownSecrets.add(value));
    workspace = await withinDeadline(deadline, () => (options.openWorkspace || openWorkspace)({ sessionId: id, siteId: scope.siteId, repository: session!.request.repository,
      existing: session!.workspace, signal: deadline, assertActive,
      onOwnedHandle: sandbox => { ownedHandle = sandbox; },
      cleanupCreated: async (sandbox) => {
        await options.assertCleanup?.();
        const fence = await claimSandboxCleanup({ sessionId: id, siteId: scope.siteId, owner, resource: sandbox.name, bootstrap: true });
        if (!fence) return;
        await fence.assert();
        await sandbox.stop({ signal: AbortSignal.timeout(60_000) });
        await fence.finish();
        ownedHandle = undefined;
      },
      host: { git: profile?.git, environment: host.values(), redactionValues: [...knownSecrets] } }));
    const configureEnvironment = async (values: Record<string, string>) => {
      runtimeSecretValues(values).forEach(value => knownSecrets.add(value));
      await host.setLayer('application', { values: { ...host.configuration.layers.application?.values, ...values } });
      await replaceWorkspaceEnvironment(workspace!, host.values(), host.configuration.redactionValues);
    };
    const tools = [...createWorkspaceTools(workspace), ...createDeliveryTools({ workspace, scope, profile }),
      ...createArchiveTool({ workspace, allowed: profile?.allowed || [], siteId: scope.siteId, redact }), ...await createCapabilityTools({
      scope, workspace, requirementId: profile?.requirementId,
      cronRun: options.cronRun,
      allowed: profile?.allowed || [], configureEnvironment,
      saveEnvironment: async (name, values, metadata) => {
        await assertActive();
        await host.setLayer(name, { values, ...metadata });
        host.configuration.redactionValues.forEach(value => knownSecrets.add(value));
        await replaceWorkspaceEnvironment(workspace!, host.values(), host.configuration.redactionValues);
      },
      assertActive,
    }), ...await options.tools?.(workspace, host) || []];
    await accountSetup();
    const result = await runRequirementAssistantSlice({ session, store, owner, run: options.cronRun,
      workspace,
      tools, redact, artifacts: createArtifactStore(), sliceMs: 60000, signal: deadline,
      context: options.context, getContext: options.getContext, assertExecution: assertActive,
      onCheckpoint: options.checkpoint ? context => options.checkpoint!({ workspace: workspace!, redact, ...context }) : undefined });
    return { status: result.status, continue: result.status === 'running' };
  } catch (error) {
    await writeRequirementInstanceLog(options.cronRun, {
      key: `cycle-error:${options.cronRun.runId}`, log_type: 'error', is_error: true,
      message: 'Assistant requirement cycle stopped. Inspect its durable checkpoint before retrying.',
      details: { error: safeError(error, redact) },
    }).catch(() => undefined);
    await accountSetup().catch(() => undefined);
    // Load CURRENT snapshot: never overwrite a newer receipt or a user pause with an old local copy.
    const current = await store.load(id, scope.siteId);
    if (current?.status === 'running') {
      try {
        await store.assertOwner(id, scope.siteId, owner, 180);
        const operatorRequired = workspaceOpenRequiresOperator(error);
        const creditsExhausted = error instanceof RequirementCreditsExhaustedError;
        if (creditsExhausted) current.creditRecoveryMinimum = error.requiredCredits;
        const boundaryFailure = error instanceof Error && (error.name === 'RecoveryError' || error.name === 'OpenRouterBillingError');
        current.status = operatorRequired || boundaryFailure ? 'paused' : 'waiting';
        current.reason = creditsExhausted ? 'account_credits_exhausted' : operatorRequired
          ? `workspace_access_requires_operator: ${safeError(error, redact)}` : boundaryFailure
          ? 'assistant_execution_requires_reconciliation' : `runtime_unavailable: ${safeError(error, redact)}`;
        await store.save(current, scope.siteId, owner);
      } catch {
        // Lease loss or persistence outage: no effects are retried. Explicit resume reconciles pending.
      }
    }
    return { status: (await store.load(id, scope.siteId))?.status || 'waiting', continue: false };
  } finally {
    try {
      if (workspace || ownedHandle) {
        await options.assertCleanup?.();
        // Atomic claim checks CURRENT nonrunning snapshot + owner + resource,
        // and prevents a user/coordinator resume during the remote stop.
        const resource = workspace?.ref.id ?? ownedHandle!.name;
        const fence = await claimSandboxCleanup({ sessionId: id, siteId: scope.siteId, owner, resource,
          bootstrap: !session.workspace && !workspace });
        if (fence) {
          if (workspace) await suspendWorkspaceForCleanup(workspace, fence.assert);
          else {
            await fence.assert();
            await ownedHandle!.stop({ signal: AbortSignal.timeout(60_000) });
          }
          await fence.finish();
        }
      }
    } catch { /* Unknown stop outcome retains durable fence, never authorizes resume. */ }
    finally { await store.release(id, scope.siteId, owner).catch(() => undefined); }
  }
}