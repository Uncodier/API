import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execution, recoveryDatabase, scope } from '@/lib/services/robot-instance/test-support/assistant-recovery-fixture';

let db: ReturnType<typeof recoveryDatabase>;
let recovery: typeof import('@/lib/services/robot-instance/assistant-recovery');
let run: typeof import('../workflow').runAssistantWorkflow;
const model = jest.fn<(...args: any[]) => Promise<any>>();
const planExecute = jest.fn<(...args: any[]) => Promise<any>>();
const getPlan = jest.fn<(...args: any[]) => Promise<any>>();
const complete = jest.fn<(...args: any[]) => Promise<void>>();
const getTools = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (table: string) => db.from(table) } }));
jest.unstable_mockModule('@/lib/services/robot-instance/assistant-executor', () => ({ executeAssistantStep: model }));
jest.unstable_mockModule('../utils', () => ({ getInstanceAssistantTools: getTools }));
jest.unstable_mockModule('../steps', () => ({ prepareAssistantContext: async () => ({
  instance: { status: 'pending' }, initialMessage: 'silent continuation', customTools: [{ name: 'sandbox' }],
  imageAssets: [], expectedResultsAmount: 1, systemPrompt: 'Original instructions', hasLinkedRequirement: false,
  executionOptions: { instance_id: scope.instanceId, site_id: scope.siteId, user_id: scope.userId, use_sdk_tools: false, provider: 'openrouter' },
}) }));
jest.unstable_mockModule('../plan-steps', () => ({ getActiveInstancePlan: getPlan,
  executePlanStep: planExecute, acquirePlanExecutionLockStep: jest.fn(), releasePlanExecutionLockStep: jest.fn() }));
jest.unstable_mockModule('../persist-and-fail-steps', () => ({
  persistUserMessageStep: jest.fn(), completeUserMessageStep: complete,
  pauseUserMessageStep: jest.fn(), markAssistantFailedStep: jest.fn(),
}));
jest.unstable_mockModule('../assistant-respawn-steps', () => ({ spawnSilentContinueStep: jest.fn() }));
jest.unstable_mockModule('../publish-node-binding', () => ({ resolvePublishNodeBinding: jest.fn() }));
jest.unstable_mockModule('@/lib/services/workflow-robot/execution-tracker', () => ({ instrumentWorkflowTools: (tools: unknown[]) => tools }));
jest.unstable_mockModule('@/lib/services/robot-instance/vision-message-images', () => ({
  hydrateMessageImages: async (messages: unknown[]) => messages, dehydrateMessageImages: (messages: unknown[]) => messages,
}));
beforeAll(async () => {
  recovery = await import('@/lib/services/robot-instance/assistant-recovery');
  ({ runAssistantWorkflow: run } = await import('../workflow'));
});
beforeEach(() => {
  jest.resetAllMocks(); db = recoveryDatabase();
  db.tables.instance_plans = [{ id: 'plan', instance_id: scope.instanceId, site_id: scope.siteId,
    title: 'Storage recovery', status: 'pending', metadata: { requirement_id: 'req' }, steps_completed: 0, steps_total: 2 }];
  db.tables.requirements = [{ id: 'req', site_id: scope.siteId, status: 'blocked', title: 'Roadmap',
    metadata: { execution_hold: { kind: 'migration_platform_review', reason: 'Missing validated repair fields' } } }];
  complete.mockImplementation(async (_id, generation) => {
    await recovery.assertAssistantRecoveryActive({ ...scope, generation });
    db.action().details.status = 'completed';
  });
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider request'));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('blocked managed task, finishable conversation', () => {
  it('resumes an expired conversation, reads the blocker and completes only its user action', async () => {
    const messages = [{ role: 'user', content: 'It should already be unblocked' }];
    await recovery.initializeAssistantRecovery(scope, execution);
    await recovery.markAssistantRecoveryInFlight(scope, messages);
    db.snapshot().lastActivityAt = db.snapshot().inFlightSince = new Date(Date.now() - 16 * 60_000).toISOString();
    const before = JSON.stringify({ plans: db.tables.instance_plans, requirements: db.tables.requirements });
    const { resumeToken } = await recovery.claimAssistantRecovery(scope, { allowStaleInFlight: true, conversationOnly: true });
    let turn = 0;
    model.mockImplementation(async (input, _instance, options) => {
      expect(options.system_prompt).toContain('CONVERSATION-ONLY RECOVERY');
      expect(options.custom_tools.map((tool: any) => tool.name)).toEqual(['conversation_status']);
      if (turn++ === 0) {
        const status = await options.custom_tools[0].execute({ action: 'status' });
        expect(status.requirements[0].status).toBe('blocked');
        expect(status.requirements[0].execution_hold).toContain('migration_platform_review');
        return { messages: [...input,
          { role: 'assistant', content: null, tool_calls: [{ id: 'status-1', type: 'function', function: { name: 'conversation_status', arguments: '{"action":"status"}' } }] },
          { role: 'tool', tool_call_id: 'status-1', content: JSON.stringify(status) }], text: '', isDone: false, usage: {} };
      }
      const answer = 'El requerimiento sigue bloqueado por revisión de plataforma. No he reanudado el plan.';
      return { messages: [...input, { role: 'assistant', content: answer }], text: answer, isDone: true, usage: {} };
    });
    const result = await run(scope.instanceId, 'Continue', scope.siteId, scope.userId, [], false,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { silentContinue: true, userMessageLogId: scope.userMessageLogId, resumeToken });
    expect(result).toMatchObject({ execution_status: 'conversation_completed', managed_work_resumed: false });
    expect(result.assistant_response).toContain('sigue bloqueado');
    expect(db.action().details.status).toBe('completed');
    expect(db.snapshot()).toMatchObject({ inFlight: false, conversationOnly: true, respawnCount: 1 });
    expect(JSON.stringify({ plans: db.tables.instance_plans, requirements: db.tables.requirements })).toBe(before);
    expect(getTools).not.toHaveBeenCalled();
    expect(getPlan).not.toHaveBeenCalled();
    expect(planExecute).not.toHaveBeenCalled();
    expect(model).toHaveBeenCalledTimes(2);
    expect(db.writes().every(query => query.table === 'instance_logs')).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});