import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

const assertOwner = jest.fn();
const connect = jest.fn();
const execute = jest.fn();
const planRead = jest.fn();
class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
const dependencies = {
  '@/lib/database/supabase-client': { supabaseAdmin: { from: jest.fn(() => ({
    select: () => ({ eq: () => ({ maybeSingle: planRead }) }),
  })) } },
  '@/lib/services/robot-instance/assistant-executor': { executeAssistantStep: execute },
  '@/app/api/robots/instance/assistant/utils': {},
  './step-history-builder': {},
  '@/lib/services/skills-service': {},
  '@/lib/services/instance-user-history': {},
  '@/lib/services/sandbox-recovery': { connectOrRecreateRequirementSandbox: connect },
  '@/lib/services/sandbox-gone-error': {},
  '@/lib/services/sandbox-service': {},
  '@/app/api/agents/tools/sandbox/assistantProtocol': {},
  '@/lib/services/sandbox-sdk': {},
  './single-turn-prompt': {},
  './single-turn-visual-feedback': {},
  './single-turn-background-task': {},
  './single-turn-helpers': {},
  './single-turn-step-state': {},
  './judge-repair-controller': {},
  '@/lib/services/cron-infrastructure-state': { CRON_INFRASTRUCTURE_PROVENANCE: 'infra' },
  '@/lib/services/instance-plan-infrastructure-state': {},
  './single-turn-gate': {},
  './no-progress-adjudication': {},
  './no-progress-gate-adjudicator': {},
  './gate-validation-cache': {},
  '@/lib/services/requirement-backlog': {},
  '@/lib/services/requirement-flows': {},
  './commit/pre-push-build-validation': {},
  '@/lib/services/requirement-constraints-persist': {},
  './repair-execution-policy': {},
  './cron-execution-ownership': {
    assertCronExecutionOwnership: assertOwner,
    CronExecutionOwnershipError: OwnershipError,
    isCronExecutionOwnershipError: (error: unknown) => error instanceof OwnershipError,
  },
};
const { executeSingleTurnStep } = loadRuntimeModule<typeof import('../single-turn-executor')>(
  'src/app/api/cron/shared/single-turn-executor.ts', dependencies,
);
const params = {
  sandboxId: 'shared-sandbox', plan: { id: 'plan' },
  step: { id: 'step', status: 'pending', infrastructure_generation: 3 },
  requirementId: 'req', instanceId: 'inst', siteId: 'site', title: 'task',
  gitRepoKind: 'applications' as const, requirementType: 'app',
  cycleId: 'original-run', executionEventId: 'original-run:turn:1',
  executionGeneration: 7, cronLockRunId: 'original-run',
};
beforeEach(() => {
  jest.resetAllMocks();
  dependencies['@/lib/database/supabase-client'].supabaseAdmin.from.mockImplementation(() => ({
    select: () => ({ eq: () => ({ maybeSingle: planRead }) }),
  }));
  assertOwner.mockResolvedValue(undefined);
  planRead.mockResolvedValue({ data: { status: 'in_progress', steps: [params.step] }, error: null });
  connect.mockResolvedValue({ sandbox: {}, sandboxId: 'shared-sandbox' });
});

it('halts a reclaimed run before plan I/O, attach, or tools', async () => {
  assertOwner.mockRejectedValue(new OwnershipError('run_owner_changed'));
  const result = await executeSingleTurnStep(params);
  expect(result).toMatchObject({ ok: false, concurrencyHalt: true, infrastructureGeneration: 3 });
  expect(assertOwner).toHaveBeenCalledWith({ requirementId: 'req', runId: 'original-run', executionGeneration: 7 });
  expect(planRead).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it('never adopts a newly fetched plan-step generation before sandbox effects', async () => {
  planRead.mockResolvedValue({ data: { status: 'in_progress', steps: [
    { ...params.step, infrastructure_generation: 8 },
  ] }, error: null });
  expect(await executeSingleTurnStep(params)).toMatchObject({
    concurrencyHalt: true, infrastructureGeneration: 3,
  });
  expect(connect).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it.each(['paused', 'cancelled'])('does not attach for a %s plan', async (status) => {
  planRead.mockResolvedValue({ data: { status, steps: [params.step] }, error: null });
  expect(await executeSingleTurnStep(params)).toMatchObject({ concurrencyHalt: true });
  expect(connect).not.toHaveBeenCalled();
});

it('re-checks owner after plan read before attaching and after attaching before effects', async () => {
  assertOwner.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new OwnershipError('changed during plan read'));
  expect(await executeSingleTurnStep(params)).toMatchObject({ concurrencyHalt: true });
  expect(connect).not.toHaveBeenCalled();
  assertOwner.mockReset();
  assertOwner.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new OwnershipError('changed during attach'));
  expect(await executeSingleTurnStep(params)).toMatchObject({ concurrencyHalt: true });
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ fastAttach: true }));
  expect(execute).not.toHaveBeenCalled();
});

it('returns already-terminal state without reattaching or executing', async () => {
  planRead.mockResolvedValue({ data: { status: 'completed', steps: [
    { ...params.step, status: 'completed' },
  ] }, error: null });
  expect(await executeSingleTurnStep(params)).toMatchObject({
    concurrencyHalt: true, persistedTerminalStatus: 'completed',
  });
  expect(connect).not.toHaveBeenCalled();
});