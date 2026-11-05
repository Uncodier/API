import { randomUUID } from 'node:crypto';
import { createMemorySessionStore } from '@/lib/harness/memory-store';
import { createSession, sessionRequestSchema } from '@/lib/harness/session';
import { OpenRouterBillingError, RequirementCreditsExhaustedError } from '@/lib/services/billing/openrouter-usage-billing';
import { SandboxBillingError } from '@/lib/services/billing/sandbox-billing';
import { AssistantExecutionBoundaryError } from '@/lib/services/robot-instance/assistant-execution-boundary';
import { cycleRuntime } from './helpers/requirement-cycle-runtime';
let store = createMemorySessionStore();
const runSlice = jest.fn();
const open = jest.fn();
const suspend = jest.fn();
const cleanup = jest.fn();
const permission = jest.fn();
const writeLog = jest.fn(async (..._args: any[]) => {});
const retireMissing = jest.fn();
jest.mock('@/lib/harness/retire-missing-workspace', () => ({ retireMissingWorkspace: (...args: any[]) => retireMissing(...args) }));
jest.mock('@/lib/harness/store', () => ({ ...jest.requireActual('@/lib/harness/store'), createSessionStore: () => store }));
jest.mock('@/lib/harness/host-state-store', () => ({ createHostStateStore: () => ({}) }));
jest.mock('@/lib/harness/host-configuration', () => ({ loadSessionConfiguration: async () => ({
  configuration: { redactionValues: [], layers: {} }, setLayer: async () => {}, values: () => ({}) }) }));
jest.mock('@/lib/harness/workspace', () => ({ openWorkspace: (...args: any[]) => open(...args),
  replaceWorkspaceEnvironment: jest.fn(), suspendWorkspaceForCleanup: (...args: any[]) => suspend(...args) }));
jest.mock('@/lib/services/billing/sandbox-cleanup-fence', () => ({ claimSandboxCleanup: (...args: any[]) => cleanup(...args) }));
jest.mock('@/lib/harness/workspace-tools', () => ({ createWorkspaceTools: () => [] }));
jest.mock('@/lib/harness/capabilities', () => ({ createCapabilityTools: async () => [], refreshTenantEnvironment: jest.fn() }));
jest.mock('@/lib/harness/delivery-tools', () => ({ createDeliveryTools: () => [] }));
jest.mock('@/lib/harness/archive-tool', () => ({ createArchiveTool: () => [] }));
jest.mock('@/lib/harness/artifact-store', () => ({ createArtifactStore: () => ({}) }));
jest.mock('@/lib/harness/profile', () => ({ resolveHostProfile: () => undefined }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({ assertToolScreenAccess: (...args: any[]) => permission(...args) }));
jest.mock('../requirement-session', () => ({ runRequirementAssistantSlice: (...args: any[]) => runSlice(...args) }));
jest.mock('../requirement-instance-log', () => ({ writeRequirementInstanceLog: (...args: any[]) => writeLog(...args) }));
import { executeRequirementAssistantWorkspace } from '../requirement-workspace';

async function fixture(activeMs = 0) {
  const scope = { siteId: randomUUID(), userId: randomUUID() };
  const session = createSession(sessionRequestSchema.parse({ objective: 'Offline cleanup',
    repository: { url: 'https://example.test/repo.git' } }));
  const run = { ...scope, sessionId: session.id, requirementId: randomUUID(), instanceId: randomUUID(), runId: randomUUID(), executionGeneration: 1 };
  session.request.requirementId = run.requirementId;
  await store.create(session, scope);
  if (activeMs) {
    const owner = randomUUID();
    const claimed = (await store.claim(session.id, scope.siteId, owner, 300))!;
    await store.save({ ...claimed, activeMs }, scope.siteId, owner);
    await store.release(session.id, scope.siteId, owner);
  }
  const assertExecution = jest.fn(async () => {
    const current = await store.load(session.id, scope.siteId);
    if (current && !['queued', 'running'].includes(current.status)) throw new Error('Active execution rejected terminal state');
  });
  const assertCleanup = jest.fn(async () => {});
  return { scope, session, options: { cronRun: run, assertExecution, assertCleanup }, assertExecution, assertCleanup };
}

beforeEach(() => {
  jest.clearAllMocks(); store = createMemorySessionStore();
  permission.mockResolvedValue(undefined);
  open.mockResolvedValue({ ref: { provider: 'vercel', id: 'offline-workspace', root: '/workspace' } });
  cleanup.mockResolvedValue({ assert: async () => {}, finish: async () => {} });
  suspend.mockResolvedValue(undefined);
});

test.each([
  [new SandboxBillingError('insufficient_credits'), 'sandbox_credits_required'],
  [new SandboxBillingError(), 'sandbox_reconciliation_required'],
  [Object.assign(new Error('safe funding failure'), { name: 'WorkspaceError', code: 'WORKSPACE_CREDITS_REQUIRED' }), 'sandbox_credits_required'],
  [Object.assign(new Error('safe accounting failure'), { name: 'WorkspaceError', code: 'WORKSPACE_BILLING_UNAVAILABLE' }), 'sandbox_reconciliation_required'],
])('persists a non-retrying accounting pause before model work (%#)', async (error, reason) => {
  const f = await fixture();
  open.mockRejectedValueOnce(error);
  const result = await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options);
  expect(result).toEqual({ status: 'paused', continue: false });
  const saved = await store.load(f.session.id, f.scope.siteId);
  expect(saved).toMatchObject({ status: 'paused', reason });
  expect(runSlice).not.toHaveBeenCalled();
});

test.each(['completed', 'paused'] as const)('terminal %s uses cleanup authority, not active execution authority', async status => {
  const f = await fixture();
  runSlice.mockImplementation(async input => store.save({ ...input.session, status }, f.scope.siteId, input.owner));
  expect(await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options)).toEqual({ status, continue: false });
  await expect(f.assertExecution()).rejects.toThrow('terminal state');
  expect(f.assertCleanup).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ sessionId: f.session.id, resource: 'offline-workspace' }));
  expect(suspend).toHaveBeenCalledTimes(1);
});

test('changed cleanup ownership never suspends a successor workspace', async () => {
  const f = await fixture();
  f.assertCleanup.mockRejectedValue(new Error('Generation changed'));
  runSlice.mockImplementation(async input => store.save({ ...input.session, status: 'completed' }, f.scope.siteId, input.owner));
  await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options);
  expect(cleanup).not.toHaveBeenCalled(); expect(suspend).not.toHaveBeenCalled();
});

test('permission failure prevents workspace provisioning and model execution', async () => {
  const f = await fixture();
  permission.mockRejectedValue(new Error('Permission denied'));
  await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options);
  expect(open).not.toHaveBeenCalled(); expect(runSlice).not.toHaveBeenCalled();
});

test('historical active time cap does not prevent workspace execution', async () => {
  const f = await fixture(14400001);
  runSlice.mockImplementation(async input => store.save({ ...input.session, status: 'completed' }, f.scope.siteId, input.owner));
  expect(await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options)).toEqual({ status: 'completed', continue: false });
  expect(open).toHaveBeenCalledTimes(1);
  expect(runSlice).toHaveBeenCalledTimes(1);
  expect(writeLog).not.toHaveBeenCalled();
  expect((await store.load(f.session.id, f.scope.siteId))?.activeMs).toBeGreaterThanOrEqual(14400001);
});

test('confirmed missing legacy reference is retired before replacement bootstrap cleanup', async () => {
  const f = await fixture();
  const owner = randomUUID();
  const claimed = (await store.claim(f.session.id, f.scope.siteId, owner, 300))!;
  await store.save({ ...claimed, workspace: { provider: 'vercel', id: 'req-old', root: '/vercel/sandbox' } }, f.scope.siteId, owner);
  await store.release(f.session.id, f.scope.siteId, owner);
  const stop = jest.fn();
  cleanup.mockImplementationOnce(async input => {
    const current = await store.load(f.session.id, f.scope.siteId);
    // Same bootstrap prerequisites as begin_harness_sandbox_cleanup.
    expect(input.bootstrap).toBe(true);
    expect(input.resource).toBe(`h-${f.session.id}`);
    expect(current?.workspace).toBeUndefined();
    expect(current?.status).toBe('running');
    return { assert: jest.fn(), finish: jest.fn() };
  });
  // The dedicated SQL CAS is covered by its real database tests. Model the
  // resulting snapshot here without relaxing generic MemorySessionStore.save.
  const originalLoad = store.load.bind(store);
  const originalSave = store.save.bind(store);
  let retired = false;
  retireMissing.mockImplementationOnce(async input => {
    expect(input.resource).toBe('req-old');
    retired = true;
  });
  jest.spyOn(store, 'load').mockImplementation(async (...args) => {
    const current = await originalLoad(...args);
    if (retired && current) delete current.workspace;
    return current;
  });
  jest.spyOn(store, 'save').mockImplementation(async (value, siteId, leaseOwner) => {
    const saved = await originalSave(retired ? { ...value,
      workspace: { provider: 'vercel', id: 'req-old', root: '/vercel/sandbox' } } : value, siteId, leaseOwner);
    if (retired) delete saved.workspace;
    return saved;
  });
  open.mockImplementationOnce(async input => {
    expect(input.existing.id).toBe('req-old');
    await input.onMissingWorkspace('req-old');
    expect((await store.load(f.session.id, f.scope.siteId))?.messages).toEqual(f.session.messages);
    await input.cleanupCreated({ name: `h-${f.session.id}`, stop });
    throw new Error('Replacement bootstrap failed');
  });
  expect(await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options))
    .toEqual({ status: 'waiting', continue: false });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(runSlice).not.toHaveBeenCalled();
});

test('transient failure after the historical time cap remains retryable', async () => {
  const f = await fixture(14400001);
  open.mockRejectedValue(new Error('Synthetic transient setup failure'));
  expect(await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options)).toEqual({ status: 'waiting', continue: false });
  expect((await store.load(f.session.id, f.scope.siteId))?.reason).not.toBe('active_time_budget_exhausted');
});

test.each([false, true])('host slice deadline waits for the next cron with saved uncertainty=%s', async uncertain => {
  const f = await fixture();
  const controller = new AbortController();
  const timeout = new DOMException('Offline slice expired', 'TimeoutError');
  const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const fences = uncertain ? ['synthetic-operation-fingerprint'] : [];
  runSlice.mockImplementationOnce(async input => {
    await store.save({ ...input.session, uncertainOperations: fences }, f.scope.siteId, input.owner);
    controller.abort(timeout); throw timeout;
  });
  try {
    expect(await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options))
      .toEqual({ status: 'waiting', continue: false });
    expect(await store.load(f.session.id, f.scope.siteId))
      .toMatchObject({ status: 'waiting', reason: 'runtime_slice_expired', turns: 0, messages: f.session.messages, uncertainOperations: fences });
    expect(suspend).toHaveBeenCalledTimes(1);
  } finally { timeoutSpy.mockRestore(); }
});

test('typed canonical interruption yields with the pending dispatch checkpoint intact', async () => {
  const f = await fixture();
  const pending = { call: { id: 'original', name: 'write', arguments: '{}' }, effect: 'write' as const, fingerprint: 'synthetic-write' };
  runSlice.mockImplementationOnce(async input => {
    await store.save({ ...input.session, pending }, f.scope.siteId, input.owner);
    throw new AssistantExecutionBoundaryError('canonical_slice_interrupted');
  });
  expect(await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options)).toEqual({ status: 'waiting', continue: false });
  expect(await store.load(f.session.id, f.scope.siteId)).toMatchObject({ status: 'waiting', reason: 'canonical_slice_interrupted', pending });
});

test.each([
  [new RequirementCreditsExhaustedError(0.4), 'account_credits_exhausted'],
  [new OpenRouterBillingError(), 'assistant_billing_unconfirmed'],
  [Object.assign(new Error('Insufficient credits'), { name: 'OpenRouterBillingError' }), 'assistant_billing_unconfirmed'],
  [Object.assign(new Error('Boundary rejected'), { name: 'RecoveryError' }), 'assistant_execution_boundary_failed'],
] as const)('persists trusted pause reason for %s', async (error, reason) => {
  const f = await fixture();
  runSlice.mockRejectedValueOnce(error);
  expect(await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options)).toEqual({ status: 'paused', continue: false });
  expect(await store.load(f.session.id, f.scope.siteId)).toMatchObject({ status: 'paused', reason });
  expect((await store.load(f.session.id, f.scope.siteId))?.creditRecoveryMinimum)
    .toBe(error instanceof RequirementCreditsExhaustedError ? 0.4 : undefined);
  expect(writeLog).toHaveBeenCalledTimes(1);
  expect(writeLog).toHaveBeenCalledWith(f.options.cronRun, expect.objectContaining({
    log_type: 'error', is_error: true,
  }));
  expect(suspend).toHaveBeenCalledTimes(1);
});

test('typed shortage does not overwrite a concurrent user pause', async () => {
  const f = await fixture();
  runSlice.mockImplementationOnce(async input => {
    await store.save({ ...input.session, status: 'paused', reason: 'user_pause' }, f.scope.siteId, input.owner);
    throw new RequirementCreditsExhaustedError(0.4);
  });
  expect(await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options)).toEqual({ status: 'paused', continue: false });
  expect(await store.load(f.session.id, f.scope.siteId)).toMatchObject({ status: 'paused', reason: 'user_pause' });
});

test('logs a safe boundary stage code rather than losing the failed execution check', async () => {
  const f = await fixture();
  runSlice.mockRejectedValueOnce(new AssistantExecutionBoundaryError('execution_check_failed'));
  await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options);
  expect(writeLog).toHaveBeenCalledWith(f.options.cronRun, expect.objectContaining({
    details: { error: 'Assistant execution boundary failed', boundary_code: 'execution_check_failed' },
  }));
});

test('a host-verified secondary audit failure yields instead of blocking the requirement', async () => {
  const f = await fixture();
  runSlice.mockRejectedValueOnce(new AssistantExecutionBoundaryError('canonical_audit_unavailable'));
  expect(await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options)).toEqual({ status: 'waiting', continue: false });
  expect(await store.load(f.session.id, f.scope.siteId)).toMatchObject({ status: 'waiting', reason: 'canonical_audit_unavailable' });
});

test.each(['save', 'load', 'lease'] as const)('preserves the original critical failure when pause %s fails', async stage => {
  const f = await fixture();
  const failure = new AssistantExecutionBoundaryError('execution_check_failed');
  const release = jest.spyOn(store, 'release');
  runSlice.mockImplementationOnce(async () => {
    const method = stage === 'lease' ? 'assertOwner' : stage;
    jest.spyOn(store, method).mockRejectedValueOnce(new Error('Offline persistence outage'));
    throw failure;
  });
  await expect(executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options)).rejects.toBe(failure);
  expect(await store.load(f.session.id, f.scope.siteId)).toMatchObject({ status: 'running' });
  expect(release).toHaveBeenCalledTimes(1);
  expect(runSlice).toHaveBeenCalledTimes(1);
});

test('preserves billing uncertainty when saving the pause fails', async () => {
  const f = await fixture();
  const failure = new OpenRouterBillingError();
  runSlice.mockImplementationOnce(async () => {
    jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('Offline pause save outage'));
    throw failure;
  });
  await expect(executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options)).rejects.toBe(failure);
});

test('a failed safe-yield save becomes a hard storage failure, not a running result', async () => {
  const f = await fixture();
  runSlice.mockImplementationOnce(async () => {
    jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('Offline yield save outage'));
    throw new AssistantExecutionBoundaryError('canonical_audit_unavailable');
  });
  await expect(executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options))
    .rejects.toMatchObject({ code: 'session_save_failed', name: 'RecoveryError' });
});

test('runtime finishes paused rather than scheduling a stale running snapshot after pause save failure', async () => {
  const f = await fixture();
  runSlice.mockImplementationOnce(async () => {
    jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('Offline pause save outage'));
    throw new AssistantExecutionBoundaryError('execution_check_failed');
  });
  const runtime = cycleRuntime({ store, environment: 'workspace', execute: () =>
    executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options) });
  expect(await runtime.run(f.options.cronRun)).toMatchObject({ status: 'paused' });
  expect(runtime.finish).toHaveBeenCalledTimes(1);
  expect(runtime.finish).toHaveBeenCalledWith(f.options.cronRun, 'paused', 'assistant_execution_execution_check_failed',
    expect.any(String), 'https://example.test/repo/tree/offline');
  expect(await store.load(f.session.id, f.scope.siteId)).toMatchObject({ status: 'running' });
});