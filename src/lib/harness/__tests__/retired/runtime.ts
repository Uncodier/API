// Historical regression fixture only. Never import from production.
import { randomUUID } from 'node:crypto';
import type { Sandbox } from '@vercel/sandbox';
import { runSessionSlice, type RunSliceInput } from './engine';
import { createBilledHarnessModel } from './requirement-model';
import { createSessionStore } from '../../store';
import { openWorkspace, replaceWorkspaceEnvironment, suspendWorkspaceForCleanup } from '../../workspace';
import { claimSandboxCleanup } from '@/lib/services/billing/sandbox-cleanup-fence';
import { createWorkspaceTools } from '../../workspace-tools';
import { createCapabilityTools, refreshTenantEnvironment } from '../../capabilities';
import { createDeliveryTools } from '../../delivery-tools';
import { createArchiveTool } from '../../archive-tool';
import { resolveHostProfile } from '../../profile';
import { createRedactor, runtimeSecretValues, safeError } from '../../security';
import { createHostStateStore } from '../../host-state-store';
import { createArtifactStore } from '../../artifact-store';
import { loadSessionConfiguration } from '../../host-configuration';
import { withinDeadline } from '../../deadline';
import { workspaceOpenRequiresOperator } from '../../workspace-open-failure';
import type { HarnessModel, HarnessTool, SessionScope, Workspace } from '../../types';
import type { HostProfile } from '../../profile';

export interface SessionRuntimeOptions {
  /** Trusted cron adapter, never deserialized from model arguments or public request JSON. */
  profile?: HostProfile;
  assertExecution?: () => Promise<void>;
  context?: string;
  /** Trusted host callback, not public/model input. Same advisory contract as the engine. */
  getContext?: RunSliceInput['getContext'];
  tools?: (workspace: Workspace, host: Awaited<ReturnType<typeof loadSessionConfiguration>>) => Promise<HarnessTool[]>;
  openWorkspace?: (input: Parameters<typeof openWorkspace>[0]) => Promise<Workspace>;
  model?: HarnessModel;
  checkpoint?: (input: { workspace: Workspace; redact: (text: string) => string;
    owner: string; assertActive: () => Promise<void>; signal: AbortSignal }) => Promise<void>;
  cronRun?: { requirementId: string; instanceId: string; runId: string; executionGeneration: number; sessionId: string };
}

/** Durable transport calls this function. Nothing here classifies product tasks or runs quality gates. */
export async function executeSessionSlice(id: string, scope: SessionScope, options: SessionRuntimeOptions = {}): Promise<{ status: string; continue: boolean }> {
  await options.assertExecution?.();
  const store = createSessionStore();
  const owner = randomUUID();
  let session = await store.claim(id, scope.siteId, owner, 300);
  if (!session) return { status: 'not_claimed', continue: false };
  const knownSecrets = new Set<string>();
  let currentHost: Awaited<ReturnType<typeof loadSessionConfiguration>> | undefined;
  const redact = (text: string) => createRedactor([...knownSecrets, ...(currentHost?.configuration.redactionValues || [])])(text);
  const remaining = session.request.limits.maxActiveMs - session.activeMs;
  if (remaining <= 0) {
    try { session.status = 'paused'; session.reason = 'active_time_budget_exhausted'; await store.save(session, scope.siteId, owner); }
    finally { await store.release(id, scope.siteId, owner); }
    return { status: 'paused', continue: false };
  }
  const deadline = AbortSignal.timeout(Math.min(210000, remaining));
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
    if (!session.request.repository) throw new Error('Retired workspace runtime requires a repository');
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
    workspace = await withinDeadline(deadline, () => (options.openWorkspace || openWorkspace)({ sessionId: id, siteId: scope.siteId, repository: session!.request.repository!,
      existing: session!.workspace, signal: deadline, assertActive,
      onOwnedHandle: sandbox => { ownedHandle = sandbox; },
      cleanupCreated: async (sandbox) => {
        await options.assertExecution?.();
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
    const result = await runSessionSlice({ session, store, owner, siteId: scope.siteId,
      workspace, model: options.cronRun && options.model ? options.model
        : createBilledHarnessModel({ sessionId: id, siteId: scope.siteId, owner }, assertActive, options.model),
      tools, redact, artifacts: createArtifactStore(), sliceMs: 60000, signal: deadline,
      context: options.context, getContext: options.getContext, assertExecution: options.assertExecution,
      onCheckpoint: options.checkpoint ? context => options.checkpoint!({ workspace: workspace!, redact, ...context }) : undefined });
    return { status: result.status, continue: result.status === 'running' };
  } catch (error) {
    await accountSetup().catch(() => undefined);
    // Load CURRENT snapshot: never overwrite a newer receipt or a user pause with an old local copy.
    const current = await store.load(id, scope.siteId);
    if (current?.status === 'running') {
      try {
        await store.assertOwner(id, scope.siteId, owner, 180);
        const budgetExhausted = current.activeMs >= current.request.limits.maxActiveMs;
        const operatorRequired = workspaceOpenRequiresOperator(error);
        current.status = budgetExhausted || operatorRequired ? 'paused' : 'waiting';
        current.reason = budgetExhausted ? 'active_time_budget_exhausted' : operatorRequired
          ? `workspace_access_requires_operator: ${safeError(error, redact)}` : `runtime_unavailable: ${safeError(error, redact)}`;
        await store.save(current, scope.siteId, owner);
      } catch {
        // Lease loss or persistence outage: no effects are retried. Explicit resume reconciles pending.
      }
    }
    return { status: (await store.load(id, scope.siteId))?.status || 'waiting', continue: false };
  } finally {
    try {
      if (workspace || ownedHandle) {
        await options.assertExecution?.();
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