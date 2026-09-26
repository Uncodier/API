import { jest } from '@jest/globals';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import type { AssistantContext } from '../types';

type AsyncMock = (...args: any[]) => Promise<any>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function harness() {
  const context: AssistantContext = {
    instance: { status: 'active' }, systemPrompt: 'Main assistant', customTools: [],
    initialMessage: 'Implement the plan', imageAssets: [], hasLinkedRequirement: false,
    expectedResultsAmount: 1,
    executionOptions: { provider: 'openai', instance_id: 'instance', site_id: 'site', user_id: 'user', use_sdk_tools: false },
  };
  const persisted: any = {
    id: 'plan', title: 'Test plan', status: 'in_progress', metadata: {},
    steps: [
      { id: 'step-1', order: 1, title: 'First step', instructions: 'Implement first', status: 'pending', result: { preserved: true } },
      { id: 'step-2', order: 2, title: 'Second step', instructions: 'Implement second', status: 'pending' },
    ],
  };
  const processAssistantTurn = jest.fn<AsyncMock>();
  const updateInstancePlanCore = jest.fn<AsyncMock>().mockImplementation(async (request: any) => {
    for (const patch of request.steps) {
      const step = persisted.steps.find((value: any) => value.id === patch.id);
      Object.assign(step, clone(patch));
    }
    return { success: true };
  });
  const maybeSingle = jest.fn<AsyncMock>().mockImplementation(async () => ({ data: clone(persisted), error: null }));
  const query: any = { maybeSingle };
  for (const method of ['select', 'eq', 'or', 'order', 'limit', 'contains', 'is']) query[method] = jest.fn(() => query);
  const redis = {
    set: jest.fn<AsyncMock>().mockResolvedValue('OK'),
    eval: jest.fn<AsyncMock>().mockResolvedValue(1),
  };
  const planSteps = loadRuntimeModule<typeof import('../plan-steps')>(
    'src/app/api/robots/instance/assistant/plan-steps.ts', {
      '@/lib/database/supabase-client': { supabaseAdmin: { from: () => query } },
      '@/app/api/agents/tools/instance_plan/update/route': { updateInstancePlanCore },
      './assistant-turn': { processAssistantTurn },
      '@/lib/services/skills-service': { SkillsService: { getSkillBySlugForSite: async () => null } },
      './skill-selection': { requiredSkillsPrompt: () => '' },
      '@/app/api/cron/shared/step-git-prompts': {
        getStepCheckpointPromptFragment: () => '', getFileFreshnessPromptFragment: () => '',
      },
      '@/lib/services/sandbox-service': { SandboxService: { WORK_DIR: '/test/workspace' } },
      '@/lib/utils/redis-client': { getRedisClient: () => redis },
      '@/lib/helpers/plan-lifecycle': { cancelPlanStepsForBacklogItem: () => { throw new Error('unexpected cancellation'); } },
      '@/lib/services/requirement-plan-backlog-gate': { evaluatePlanBacklogGate: () => ({ runnable: true }) },
    },
  );
  const completeUserMessageStep = jest.fn<AsyncMock>();
  const markAssistantFailedStep = jest.fn<AsyncMock>();
  const countRecentRespawnsStep = jest.fn<AsyncMock>().mockResolvedValue(0);
  const spawnSilentContinueStep = jest.fn<AsyncMock>();
  const workflow = loadRuntimeModule<typeof import('../workflow')>(
    'src/app/api/robots/instance/assistant/workflow.ts', {
      './assistant-turn': { processAssistantTurn },
      './steps': { prepareAssistantContext: async () => context },
      './plan-steps': planSteps,
      './persist-and-fail-steps': {
        persistUserMessageStep: async () => ({ id: 'user-log' }), completeUserMessageStep, markAssistantFailedStep,
      },
      '@/lib/services/robot-instance/assistant-respawn': {
        isIncompleteTurn: (result: any) => !result.isDone || !result.text?.trim(),
        MAX_RESPAWNS: 2, SILENT_CONTINUE_PROMPT: 'silent continue',
      },
      './assistant-respawn-steps': { countRecentRespawnsStep, spawnSilentContinueStep },
    },
  );
  const result = (messages: any[], isDone = false, text = '') => ({
    text, messages, isDone, steps: [], output: null,
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  });
  let effects = 0;
  const doTurn = async (_context: any, messages: any[]) => {
    effects++;
    return result([...messages, { role: 'assistant', content: null, tool_calls: [
      { id: `call-${effects}`, type: 'function', function: { name: 'write', arguments: '{}' } },
    ] }, { role: 'tool', tool_call_id: `call-${effects}`, content: `Effect ${effects} already applied` }]);
  };
  const run = () => workflow.runAssistantWorkflow('instance', 'Implement plan', 'site', 'user', [], false);
  return { context, persisted, result, doTurn, effects: () => effects, run,
    processAssistantTurn, updateInstancePlanCore, planSteps, redis, maybeSingle, query,
    completeUserMessageStep, markAssistantFailedStep, countRecentRespawnsStep, spawnSilentContinueStep };
}

describe('interactive plan exhaustion and safe resumption', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns exhaustion after ten unfinished turns without completing the step', async () => {
    const h = harness();
    h.processAssistantTurn.mockImplementation(h.doTurn);
    const response = await h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0]));
    expect(response).toMatchObject({ executionStatus: 'exhausted', isDone: false, turns: 10, resumeFromStepId: 'step-1' });
    expect(h.effects()).toBe(10);
    expect(h.processAssistantTurn).toHaveBeenCalledTimes(10);
    expect(h.persisted.steps[0]).toMatchObject({ status: 'in_progress', completed_at: null,
      result: { preserved: true, assistant_execution: { version: 1, state: 'exhausted', turns: 10, messages: response.messages } } });
    expect(h.updateInstancePlanCore.mock.calls.some(([request]) => request.steps.some((step: any) => step.status === 'completed'))).toBe(false);
    expect(h.planSteps.executePlanStep.maxRetries).toBe(0);
    expect(h.updateInstancePlanCore.mock.calls.every(([, options]) => options?.trustedRunner === true)).toBe(true);
  });

  it('re-reads the scoped current checkpoint even when passed a stale pending step', async () => {
    const h = harness();
    const stalePlan = clone(h.persisted);
    const staleStep = clone(h.persisted.steps[0]);
    h.processAssistantTurn.mockImplementation(h.doTurn);
    const paused = await h.planSteps.executePlanStep(h.context, stalePlan, staleStep);
    h.processAssistantTurn.mockClear();
    h.processAssistantTurn.mockImplementation(async (_context, messages) => h.result(messages, true, 'Finished'));
    await h.planSteps.executePlanStep(h.context, stalePlan, staleStep);
    expect(h.processAssistantTurn.mock.calls[0][1]).toEqual(paused.messages);
    expect(h.effects()).toBe(10);
    expect(h.query.eq).toHaveBeenCalledWith('id', 'plan');
    expect(h.query.eq).toHaveBeenCalledWith('instance_id', 'instance');
    expect(h.query.eq).toHaveBeenCalledWith('site_id', 'site');
  });

  it('cannot replay a stale exhausted checkpoint already consumed by another execution', async () => {
    const h = harness();
    h.persisted.steps[0].status = 'in_progress';
    h.persisted.steps[0].result.assistant_execution = {
      version: 1, state: 'exhausted', turns: 10, messages: [{ role: 'user', content: 'stale continuation' }],
    };
    const stalePlan = clone(h.persisted);
    const staleStep = clone(h.persisted.steps[0]);
    h.persisted.steps[0].result.assistant_execution = { version: 1, state: 'running' };
    await expect(h.planSteps.executePlanStep(h.context, stalePlan, staleStep)).rejects.toThrow('uncertain effects');
    expect(h.processAssistantTurn).not.toHaveBeenCalled();
    expect(h.updateInstancePlanCore).not.toHaveBeenCalled();
  });

  it.each(['completed', 'cancelled', 'failed', 'missing'])('rejects stale runnable inputs when the current step is %s', async state => {
    const h = harness();
    const stalePlan = clone(h.persisted);
    const staleStep = clone(h.persisted.steps[0]);
    if (state === 'missing') h.persisted.steps.shift();
    else h.persisted.steps[0].status = state;
    await expect(h.planSteps.executePlanStep(h.context, stalePlan, staleStep)).rejects.toThrow('not runnable');
    expect(h.processAssistantTurn).not.toHaveBeenCalled();
    expect(h.updateInstancePlanCore).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { message: 'database unavailable' } },
    { data: null, error: null },
  ])('fails closed when authoritative scoped state cannot be loaded: %j', async readResult => {
    const h = harness();
    h.maybeSingle.mockResolvedValue(readResult);
    await expect(h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0])))
      .rejects.toThrow('Failed to load authoritative plan');
    expect(h.processAssistantTurn).not.toHaveBeenCalled();
    expect(h.updateInstancePlanCore).not.toHaveBeenCalled();
  });

  it.each([{ success: false, error: 'storage unavailable' }, undefined])('requires an acknowledged start checkpoint before any effects: %j', async writeResult => {
    const h = harness();
    h.updateInstancePlanCore.mockResolvedValue(writeResult);
    h.processAssistantTurn.mockImplementation(h.doTurn);
    await expect(h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0])))
      .rejects.toThrow('Failed to persist plan step start checkpoint');
    expect(h.processAssistantTurn).not.toHaveBeenCalled();
    expect(h.updateInstancePlanCore.mock.calls[0][1]).toEqual({ trustedRunner: true });
    expect(h.effects()).toBe(0);
  });

  it('does not advertise resumability when exhaustion persistence returns success:false', async () => {
    const h = harness();
    const stalePlan = clone(h.persisted);
    const staleStep = clone(h.persisted.steps[0]);
    const write = h.updateInstancePlanCore.getMockImplementation()!;
    h.updateInstancePlanCore.mockImplementation(async (request, options) => {
      if (request.steps[0].result?.assistant_execution?.state === 'exhausted') return { success: false, error: 'checkpoint unavailable' };
      return write(request, options);
    });
    h.processAssistantTurn.mockImplementation(h.doTurn);
    await expect(h.planSteps.executePlanStep(h.context, stalePlan, staleStep))
      .rejects.toThrow('Failed to persist plan step exhaustion checkpoint: checkpoint unavailable');
    expect(h.effects()).toBe(10);
    expect(h.persisted.steps[0].result.assistant_execution.state).toBe('running');
    await expect(h.planSteps.executePlanStep(h.context, stalePlan, staleStep)).rejects.toThrow('uncertain effects');
    expect(h.effects()).toBe(10);
  });

  it('does not claim workflow success when completion persistence returns success:false', async () => {
    const h = harness();
    const write = h.updateInstancePlanCore.getMockImplementation()!;
    h.updateInstancePlanCore.mockImplementation(async (request, options) => {
      if (request.steps[0].status === 'completed') return { success: false, error: 'completion unavailable' };
      return write(request, options);
    });
    h.processAssistantTurn.mockImplementation(async (_context, messages) => h.result(messages, true, 'Finished'));
    await expect(h.run()).rejects.toThrow('Failed to persist plan step completion: completion unavailable');
    expect(h.completeUserMessageStep).not.toHaveBeenCalled();
    expect(h.markAssistantFailedStep).toHaveBeenCalledTimes(1);
    expect(h.redis.eval).toHaveBeenCalledTimes(1);
    expect(h.persisted.steps[0]).toMatchObject({ status: 'in_progress', result: { assistant_execution: { state: 'running' } } });
    expect(h.persisted.steps[1].status).toBe('pending');
  });

  it('resumes persisted history rather than replaying prior turns, then clears the checkpoint on completion', async () => {
    const h = harness();
    h.processAssistantTurn.mockImplementation(h.doTurn);
    const paused = await h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0]));
    const baseline = h.persisted.steps[0].started_at;
    h.processAssistantTurn.mockClear();
    h.processAssistantTurn.mockImplementation(async (_context, messages) => h.result([...messages, { role: 'assistant', content: 'Finished' }], true, 'Finished'));
    const completed = await h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0]));
    expect(h.processAssistantTurn).toHaveBeenCalledTimes(1);
    expect(h.processAssistantTurn.mock.calls[0][1]).toEqual(paused.messages);
    expect(h.processAssistantTurn.mock.calls[0][0].executionOptions.cycle_baseline_at).toBe(baseline);
    expect(h.effects()).toBe(10);
    expect(completed).toMatchObject({ executionStatus: 'completed', isDone: true, turns: 1 });
    expect(h.persisted.steps[0]).toMatchObject({ status: 'completed', actual_output: 'Finished', started_at: baseline,
      result: { preserved: true, assistant_execution: null } });
    expect(h.persisted.steps[0].completed_at).toEqual(expect.any(String));
  });

  it('supports repeated bounded batches without resetting cumulative progress', async () => {
    const h = harness();
    h.processAssistantTurn.mockImplementation(h.doTurn);
    await h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0]));
    const firstHistory = clone(h.persisted.steps[0].result.assistant_execution.messages);
    await h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0]));
    expect(h.processAssistantTurn.mock.calls[10][1]).toEqual(firstHistory);
    expect(h.persisted.steps[0].result.assistant_execution).toMatchObject({ state: 'exhausted', turns: 20 });
    expect(h.effects()).toBe(20);
  });

  it('can complete on exactly the tenth turn (budget alone never determines completion)', async () => {
    const h = harness();
    let turn = 0;
    h.processAssistantTurn.mockImplementation(async (_context, messages) => h.result(messages, ++turn === 10, 'Finished'));
    const result = await h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0]));
    expect(result.executionStatus).toBe('completed');
    expect(result.turns).toBe(10);
    expect(h.persisted.steps[0].status).toBe('completed');
  });

  it('keeps errors non-retryable at the durable batch boundary and never marks them completed', async () => {
    const h = harness();
    h.processAssistantTurn.mockImplementationOnce(h.doTurn).mockRejectedValueOnce(new Error('transport failed after effect'));
    await expect(h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0])))
      .rejects.toThrow('transport failed after effect');
    expect(h.effects()).toBe(1);
    expect(h.planSteps.executePlanStep.maxRetries).toBe(0);
    expect(h.persisted.steps[0].status).toBe('failed');
    expect(h.updateInstancePlanCore.mock.calls.some(([request]) => request.steps.some((step: any) => step.status === 'completed'))).toBe(false);
  });

  it('refuses stale checkpoint replay if exhaustion persistence fails after effects', async () => {
    const h = harness();
    h.processAssistantTurn.mockImplementation(h.doTurn);
    const write = h.updateInstancePlanCore.getMockImplementation()!;
    h.updateInstancePlanCore.mockImplementation(async request => {
      if (request.steps[0].result?.assistant_execution?.state === 'exhausted') throw new Error('checkpoint storage unavailable');
      return write(request);
    });
    await expect(h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0])))
      .rejects.toThrow('checkpoint storage unavailable');
    expect(h.effects()).toBe(10);
    expect(h.persisted.steps[0].result.assistant_execution.state).toBe('running');
    await expect(h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0])))
      .rejects.toThrow('uncertain effects');
    expect(h.effects()).toBe(10);
  });

  it('rejects a malformed continuation instead of restarting it', async () => {
    const h = harness();
    h.persisted.steps[0].result.assistant_execution = { version: 1, state: 'exhausted', messages: [] };
    await expect(h.planSteps.executePlanStep(h.context, clone(h.persisted), clone(h.persisted.steps[0])))
      .rejects.toThrow('refusing to replay');
    expect(h.processAssistantTurn).not.toHaveBeenCalled();
    expect(h.updateInstancePlanCore).not.toHaveBeenCalled();
  });

  it('workflow reports a non-success pause, releases the lock, and does not run later steps or complete the user message', async () => {
    const h = harness();
    h.processAssistantTurn.mockImplementation(async (context, messages) => {
      if (context.systemPrompt === 'Main assistant') return h.result(messages, true, 'Ready to execute');
      const turn = await h.doTurn(context, messages);
      return { ...turn, text: 'Everything completed successfully' }; // untrusted progress is not a terminal result
    });
    const response = await h.run();
    expect(response).toMatchObject({ success: false, execution_status: 'exhausted', resumable: true, plan_id: 'plan', plan_step_id: 'step-1' });
    expect(response.message).toContain('not complete');
    expect(response.assistant_response).not.toContain('Everything completed successfully');
    expect(response).not.toHaveProperty('output');
    expect(h.effects()).toBe(10);
    expect(h.persisted.steps[1].status).toBe('pending');
    expect(h.redis.eval).toHaveBeenCalledTimes(1);
    expect(h.redis.eval.mock.calls[0].slice(1)).toEqual([1, 'workflow_lock:plan:plan', 'local-test-lock-token']);
    expect(h.completeUserMessageStep).not.toHaveBeenCalled();
    expect(h.markAssistantFailedStep).not.toHaveBeenCalled();
    expect(h.spawnSilentContinueStep).not.toHaveBeenCalled();
  });

  it('workflow preserves successful completion and executes subsequent steps only after actual completion', async () => {
    const h = harness();
    h.processAssistantTurn.mockImplementation(async (_context, messages) => h.result(messages, true, 'Finished'));
    const response = await h.run();
    expect(response.message).toBe('Plan execution completed successfully');
    expect(h.persisted.steps.map((step: any) => step.status)).toEqual(['completed', 'completed']);
    expect(h.completeUserMessageStep).toHaveBeenCalledWith('user-log');
    expect(h.redis.eval).toHaveBeenCalledTimes(1);
  });
});