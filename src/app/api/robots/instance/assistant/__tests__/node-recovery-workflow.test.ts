import { describe, expect, it, jest } from '@jest/globals';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

type AsyncMock = (...args: any[]) => Promise<any>;
function setup() {
  const transcript = [{ role: 'user', content: 'Publish the connected video' }];
  const execution = { customTools: [], useSdkTools: false, systemPrompt: 'Node prompt',
    instanceNodeId: 'node', expectedResultsAmount: 1, contextString: '{"publish_destinations":["tiktok"]}',
    toolOverrides: { publish: { social_accounts: ['tiktok'] } } };
  const context: any = { instance: { status: 'paused' }, initialMessage: transcript[0].content,
    instanceNodeId: 'node', imageAssets: [], expectedResultsAmount: 1, executionOptions: {}, hasLinkedRequirement: false };
  const processAssistantTurn = jest.fn<AsyncMock>();
  const prepareRecoveryStep = jest.fn<AsyncMock>().mockResolvedValue({ ok: true });
  const guardRecoveryStep = jest.fn<AsyncMock>().mockResolvedValue(true);
  const checkpointRecoveryStep = jest.fn<AsyncMock>().mockResolvedValue(true);
  const spawnSilentContinueStep = jest.fn<AsyncMock>().mockResolvedValue(true);
  const completeUserMessageStep = jest.fn<AsyncMock>();
  const pauseUserMessageStep = jest.fn<AsyncMock>();
  const markAssistantFailedStep = jest.fn<AsyncMock>();
  const prepareAssistantContext = jest.fn<AsyncMock>().mockResolvedValue(context);
  const result = (messages: any[], text = '', isDone = false) => ({
    messages, text, isDone, continuation: { responseNodeIds: ['response'] }, steps: [], usage: {}, output: null,
  });
  const workflow = loadRuntimeModule<typeof import('../workflow')>('src/app/api/robots/instance/assistant/workflow.ts', {
    './assistant-turn': { processAssistantTurn }, './steps': { prepareAssistantContext },
    './plan-steps': { getActiveInstancePlan: async () => null },
    './persist-and-fail-steps': { completeUserMessageStep, pauseUserMessageStep, markAssistantFailedStep,
      persistUserMessageStep: async () => ({ id: 'user-log' }) },
    '@/lib/services/robot-instance/assistant-respawn': {
      isIncompleteTurn: (r: any) => !r.isDone || !r.text?.trim(), SILENT_CONTINUE_PROMPT: 'silent continue',
    },
    './assistant-respawn-steps': { spawnSilentContinueStep },
    './assistant-recovery-steps': { prepareRecoveryStep, guardRecoveryStep, checkpointRecoveryStep },
  });
  const run = (options: any = { userMessageLogId: 'user-log' }) => workflow.runAssistantWorkflow(
    'instance', 'Publish the connected video', 'site', 'user', execution.customTools, false,
    execution.systemPrompt, undefined, undefined, execution.instanceNodeId, 1,
    execution.contextString, execution.toolOverrides, options,
  );
  return { run, context, execution, transcript, processAssistantTurn, prepareRecoveryStep, guardRecoveryStep,
    checkpointRecoveryStep, spawnSilentContinueStep, completeUserMessageStep, pauseUserMessageStep,
    markAssistantFailedStep, prepareAssistantContext, result };
}

describe('node execution continuation workflow', () => {
  it('continues after a publish receipt with the same transcript and response node, without replaying the send', async () => {
    const h = setup();
    let sends = 0;
    const receipt = { role: 'tool', tool_call_id: 'publish-call', content: '{"post_id":"already-sent"}' };
    h.processAssistantTurn.mockImplementation(async (context, messages) => {
      if (sends === 0) {
        sends++;
        expect(context.nodeContinuation).toBeUndefined();
        return h.result([...messages, receipt]);
      }
      expect(context.nodeContinuation).toEqual({ responseNodeIds: ['response'] });
      expect(messages[messages.length - 1]).toEqual(receipt);
      return h.result([...messages, { role: 'assistant', content: 'Accepted, pending delivery' }], 'Accepted, pending delivery', true);
    });
    const response = await h.run();
    expect(response.assistant_response).toBe('Accepted, pending delivery');
    expect(sends).toBe(1);
    expect(h.checkpointRecoveryStep).toHaveBeenCalledTimes(2);
    expect(h.spawnSilentContinueStep).not.toHaveBeenCalled();
    expect(h.completeUserMessageStep).toHaveBeenCalledWith('user-log');
  });

  it('restores the original node, overrides, response ID and messages from a claimed checkpoint', async () => {
    const h = setup();
    const messages = [...h.transcript, { role: 'tool', content: 'Receipt from previous chunk' }];
    h.prepareRecoveryStep.mockResolvedValue({ ok: true, snapshot: { execution: { ...h.execution,
      instanceNodeId: 'original-node', toolOverrides: { publish: { social_accounts: ['tt-only'] } } },
    messages, continuation: { responseNodeIds: ['original-response'] }, respawnCount: 1 } });
    h.processAssistantTurn.mockImplementation(async (context, input) => {
      expect(input).toEqual(messages);
      expect(context.recoveryScope.generation).toBe(1);
      expect(context.nodeContinuation.responseNodeIds).toEqual(['original-response']);
      return h.result(input, 'Done', true);
    });
    await h.run({ silentContinue: true, userMessageLogId: 'user-log', resumeToken: 'token' });
    expect(h.prepareAssistantContext.mock.calls[0][9]).toBe('original-node');
    expect(h.prepareAssistantContext.mock.calls[0][12]).toEqual({ publish: { social_accounts: ['tt-only'] } });
  });

  it.each([{ silentContinue: true }, { silentContinue: true, userMessageLogId: 'user-log' }])(
    'refuses legacy unbound continuations: %j', async (options) => {
      const h = setup();
      expect((await h.run(options)).success).toBe(false);
      expect(h.processAssistantTurn).not.toHaveBeenCalled();
      expect(h.prepareAssistantContext).not.toHaveBeenCalled();
    },
  );

  it('does not execute when checkpoint or original node is missing/changed', async () => {
    const h = setup(); h.prepareRecoveryStep.mockResolvedValue({ ok: false });
    expect((await h.run()).success).toBe(false);
    expect(h.processAssistantTurn).not.toHaveBeenCalled();
  });

  it('stops before the next model chunk when a user cancels, supersedes or changes the node', async () => {
    const h = setup(); h.guardRecoveryStep.mockResolvedValueOnce(true).mockResolvedValue(false);
    h.processAssistantTurn.mockImplementation(async (_context, messages) => h.result(messages));
    expect((await h.run()).success).toBe(false);
    expect(h.processAssistantTurn).toHaveBeenCalledTimes(1);
    expect(h.spawnSilentContinueStep).not.toHaveBeenCalled();
    expect(h.completeUserMessageStep).not.toHaveBeenCalled();
  });

  it('never retries a tool-effect chunk whose checkpoint failed', async () => {
    const h = setup(); h.checkpointRecoveryStep.mockResolvedValue(false);
    h.processAssistantTurn.mockImplementation(async (_context, messages) => h.result(messages));
    expect((await h.run()).success).toBe(false);
    expect(h.processAssistantTurn).toHaveBeenCalledTimes(1);
    expect(h.spawnSilentContinueStep).not.toHaveBeenCalled();
  });

  it('claims a persisted continuation after the chunk budget instead of starting a general assistant', async () => {
    const h = setup(); h.processAssistantTurn.mockImplementation(async (_context, messages) => h.result(messages));
    expect((await h.run()).execution_status).toBe('continuing');
    expect(h.processAssistantTurn).toHaveBeenCalledTimes(20);
    expect(h.spawnSilentContinueStep).toHaveBeenCalledWith({ instanceId: 'instance', siteId: 'site', userId: 'user', userMessageLogId: 'user-log' });
    expect(h.completeUserMessageStep).not.toHaveBeenCalled();
  });

  it('pauses honestly if durable respawn claims are exhausted', async () => {
    const h = setup(); h.spawnSilentContinueStep.mockResolvedValue(false);
    h.processAssistantTurn.mockImplementation(async (_context, messages) => h.result(messages));
    const result = await h.run();
    expect(result).toMatchObject({ success: false, execution_status: 'exhausted' });
    expect(h.pauseUserMessageStep).toHaveBeenCalledWith('user-log');
    expect(h.completeUserMessageStep).not.toHaveBeenCalled();
  });

  it('never replays a partially completed multi-output fan-out', async () => {
    const h = setup(); h.processAssistantTurn.mockImplementation(async (_context, messages) => ({
      ...h.result(messages), executionStatus: 'exhausted', resumable: false,
    }));
    expect((await h.run()).execution_status).toBe('exhausted');
    expect(h.processAssistantTurn).toHaveBeenCalledTimes(1);
    expect(h.spawnSilentContinueStep).not.toHaveBeenCalled();
  });
});