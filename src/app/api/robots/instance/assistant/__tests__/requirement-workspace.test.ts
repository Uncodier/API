import { randomUUID } from 'node:crypto';
import { createMemorySessionStore } from '@/lib/harness/memory-store';
import { createSession, sessionRequestSchema } from '@/lib/harness/session';
import { OpenRouterBillingError, RequirementCreditsExhaustedError } from '@/lib/services/billing/openrouter-usage-billing';
let store = createMemorySessionStore();
const runSlice = jest.fn();
const open = jest.fn();
const suspend = jest.fn();
const cleanup = jest.fn();
const permission = jest.fn();
const writeLog = jest.fn(async (..._args: any[]) => {});
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

test('transient failure after the historical time cap remains retryable', async () => {
  const f = await fixture(14400001);
  open.mockRejectedValue(new Error('Synthetic transient setup failure'));
  expect(await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options)).toEqual({ status: 'waiting', continue: false });
  expect((await store.load(f.session.id, f.scope.siteId))?.reason).not.toBe('active_time_budget_exhausted');
});

test('host slice deadline waits for the next cron instead of a permanent pause', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const timeout = new DOMException('Offline slice expired', 'TimeoutError');
  const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  runSlice.mockImplementationOnce(async () => { controller.abort(timeout); throw timeout; });
  try {
    expect(await executeRequirementAssistantWorkspace(f.session.id, f.scope, f.options))
      .toEqual({ status: 'waiting', continue: false });
    expect(await store.load(f.session.id, f.scope.siteId))
      .toMatchObject({ status: 'waiting', reason: 'runtime_slice_expired', turns: 0, messages: f.session.messages });
    expect(suspend).toHaveBeenCalledTimes(1);
  } finally { timeoutSpy.mockRestore(); }
});

test.each([
  [new RequirementCreditsExhaustedError(0.4), 'account_credits_exhausted'],
  [new OpenRouterBillingError(), 'assistant_execution_requires_reconciliation'],
  [Object.assign(new Error('Insufficient credits'), { name: 'OpenRouterBillingError' }), 'assistant_execution_requires_reconciliation'],
  [Object.assign(new Error('Boundary rejected'), { name: 'RecoveryError' }), 'assistant_execution_requires_reconciliation'],
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