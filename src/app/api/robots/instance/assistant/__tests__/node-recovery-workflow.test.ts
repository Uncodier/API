import { describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { buildAssistantUserContent } from '@/lib/services/robot-instance/assistant-image-content';
import { isInsufficientCreditsError } from '@/lib/services/billing/credit-exhaustion-message';
import { ASSISTANT_FAILURE_MESSAGE } from '@/lib/services/robot-instance/assistant-failure-policy';

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
  const sleep = jest.fn<AsyncMock>().mockResolvedValue(undefined);
  const completeUserMessageStep = jest.fn<AsyncMock>();
  const pauseUserMessageStep = jest.fn<AsyncMock>();
  const markAssistantFailedStep = jest.fn<AsyncMock>();
  const getActiveInstancePlan = jest.fn<AsyncMock>().mockResolvedValue(null);
  const executePlanStep = jest.fn<AsyncMock>();
  const prepareAssistantContext = jest.fn<AsyncMock>().mockResolvedValue(context);
  const bindDirectPromptAgentStep = jest.fn<AsyncMock>().mockResolvedValue(false);
  const result = (messages: any[], text = '', isDone = false) => ({
    messages, text, isDone, continuation: { responseNodeIds: ['response'] }, steps: [], usage: {}, output: null,
  });
  const workflow = loadRuntimeModule<typeof import('../workflow')>('src/app/api/robots/instance/assistant/workflow.ts', {
    workflow: { sleep },
    '@/lib/services/robot-instance/assistant-failure-policy': { ASSISTANT_FAILURE_MESSAGE },
    '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError },
    '@/lib/services/robot-instance/assistant-image-content': { buildAssistantUserContent },
    './assistant-turn': { processAssistantTurn }, './steps': { prepareAssistantContext, bindDirectPromptAgentStep },
    './plan-steps': { getActiveInstancePlan, executePlanStep },
    './persist-and-fail-steps': { completeUserMessageStep, pauseUserMessageStep, markAssistantFailedStep,
      persistUserMessageStep: async () => ({ id: 'user-log' }) },
    '@/lib/services/robot-instance/assistant-respawn-policy': {
      isIncompleteTurn: (r: any) => !r.isDone || !r.text?.trim(), SILENT_CONTINUE_PROMPT: 'silent continue',
    },
    './assistant-respawn-steps': { spawnSilentContinueStep },
    './assistant-recovery-steps': { prepareRecoveryStep, guardRecoveryStep, checkpointRecoveryStep },
  });
  const run = (options: any = { userMessageLogId: 'user-log' }) => workflow.runAssistantWorkflow(
    'instance', 'Publish the connected video', 'site', 'user', execution.customTools, false,
    execution.systemPrompt, undefined, undefined, context.instanceNodeId, 1,
    execution.contextString, execution.toolOverrides, options,
  );
  return { run, context, execution, transcript, processAssistantTurn, prepareRecoveryStep, guardRecoveryStep,
    checkpointRecoveryStep, spawnSilentContinueStep, completeUserMessageStep, pauseUserMessageStep,
    markAssistantFailedStep, prepareAssistantContext, bindDirectPromptAgentStep, getActiveInstancePlan, executePlanStep, result, sleep };
}

describe('node execution continuation workflow', () => {
  it.each([true,false])('uses a private connector only when the actual prepared prompt agent was pinned: %s', async pinned => {
    const h = setup(); h.context.instanceNodeId = undefined; h.context.connectorAgentId = 'prepared-agent';
    h.bindDirectPromptAgentStep.mockResolvedValue(pinned);
    h.processAssistantTurn.mockResolvedValue(h.result(h.transcript,'Done',true));
    await h.run({userMessageLogId:'user-log',catalogUserSession:true,executionMode:'direct',callerSource:'interactive'});
    expect(h.bindDirectPromptAgentStep).toHaveBeenCalledWith({instanceId:'instance',siteId:'site',userId:'user',userMessageLogId:'user-log'},'prepared-agent');
    expect(h.processAssistantTurn.mock.calls[0][0].catalogUserSession).toBe(pinned ? true : undefined);
  });
  it.each(['selected', 'unselected', 'malformed'])('prompts an admitted Ask turn to preserve origin and account (%s)', async selection => {
    const h = setup(); h.context.instanceNodeId = undefined; h.context.connectorAgentId = 'prepared-agent';
    h.context.systemPrompt = 'Base instructions';
    const id = randomUUID(), marker = `Account name ${randomUUID()}`;
    h.bindDirectPromptAgentStep.mockResolvedValue(true);
    h.processAssistantTurn.mockResolvedValue(h.result(h.transcript,'Done',true));
    await h.run({userMessageLogId:'user-log',catalogUserSession:true,executionMode:'direct',callerSource:'interactive',
      connectorIdHint:selection === 'selected' ? id : selection === 'malformed' ? marker : undefined});
    const prompt = h.processAssistantTurn.mock.calls[0][0].systemPrompt;
    expect(prompt).toContain('tool_origin="provider"'); expect(prompt).toContain('tool_origin="makinari_report"');
    expect(prompt).toContain('report:<id>:MAKINARI_METRICS'); expect(prompt).toContain('ask which account');
    expect(prompt).toMatch(/never substitute a report for a provider tool/i); expect(prompt).not.toContain(marker);
    if (selection === 'selected') expect(prompt).toContain(`connector_id is ${id}`);
    else expect(prompt).not.toContain(id);
  });
  it('a recovered conversation cannot inherit private connector execution with a newly prepared agent', async () => {
    const h = setup(); h.context.instanceNodeId = undefined;
    h.prepareRecoveryStep.mockResolvedValue({ ok:true, snapshot:{ messages:h.transcript, respawnCount:1,
      execution:{ customTools:[],useSdkTools:false,executionMode:'direct',callerSource:'interactive',catalogUserSession:true } } });
    h.processAssistantTurn.mockResolvedValue(h.result(h.transcript, 'Resumed safely', true));
    await h.run({userMessageLogId:'user-log',resumeToken:'resume'});
    expect(h.processAssistantTurn).toHaveBeenCalled();
    expect(h.processAssistantTurn.mock.calls[0][0].catalogUserSession).toBeUndefined();
    expect(h.bindDirectPromptAgentStep).not.toHaveBeenCalled();
  });

  it('retains an interrupted recovery checkpoint without failing the action or replaying its tools', async () => {
    const h = setup();
    h.processAssistantTurn.mockResolvedValue({
      recoveryUnavailable: true, recoveryCode: 'conflict', isDone: false, text: '',
    });
    expect(await h.run()).toMatchObject({ success: false, execution_status: 'paused' });
    expect(h.processAssistantTurn).toHaveBeenCalledTimes(1);
    expect(h.markAssistantFailedStep).not.toHaveBeenCalled();
    expect(h.checkpointRecoveryStep).not.toHaveBeenCalled();
    expect(h.completeUserMessageStep).not.toHaveBeenCalled();
    expect(h.pauseUserMessageStep).not.toHaveBeenCalled();
    expect(h.spawnSilentContinueStep).not.toHaveBeenCalled();
    expect(h.executePlanStep).not.toHaveBeenCalled();
  });

  it('silently continues a safely released transient failure without marking or checkpointing it', async () => {
    const h = setup();
    h.processAssistantTurn.mockResolvedValue({ recoverableFailure: true });
    expect(await h.run()).toMatchObject({ execution_status: 'continuing' });
    expect(h.processAssistantTurn).toHaveBeenCalledTimes(1);
    expect(h.spawnSilentContinueStep).toHaveBeenCalledWith(expect.objectContaining({ userMessageLogId: 'user-log' }));
    expect(h.markAssistantFailedStep).not.toHaveBeenCalled();
    expect(h.checkpointRecoveryStep).not.toHaveBeenCalled();
    expect(h.completeUserMessageStep).not.toHaveBeenCalled();
  });

  it('returns a safe terminal message when continuation is exhausted', async () => {
    const h = setup();
    h.processAssistantTurn.mockResolvedValue({ recoverableFailure: true });
    h.spawnSilentContinueStep.mockResolvedValue(false);
    expect(await h.run()).toMatchObject({ execution_status: 'failed', assistant_response: ASSISTANT_FAILURE_MESSAGE });
    expect(h.markAssistantFailedStep).toHaveBeenCalledTimes(1);
  });

  it('does not mark an ambiguously admitted continuation failed', async () => {
    const h = setup();
    h.processAssistantTurn.mockResolvedValue({ recoverableFailure: true });
    h.spawnSilentContinueStep.mockResolvedValue(false);
    h.guardRecoveryStep.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await h.run()).toMatchObject({ execution_status: 'paused' });
    expect(h.markAssistantFailedStep).not.toHaveBeenCalled();
  });

  it('waits durably for Retry-After before requesting a continuation', async () => {
    const h = setup();
    const deadline = Date.now() + 3600000;
    h.processAssistantTurn.mockResolvedValue({ recoverableFailure: true, retryNotBefore: deadline });
    h.spawnSilentContinueStep.mockImplementation(async () => {
      expect(h.sleep).toHaveBeenCalledTimes(1);
      return true;
    });
    expect(await h.run()).toMatchObject({ execution_status: 'continuing' });
    expect(h.sleep.mock.calls[0][0].getTime()).toBe(deadline);
  });

  it('does not continue after cancellation during the provider wait', async () => {
    const h = setup();
    h.processAssistantTurn.mockResolvedValue({ recoverableFailure: true, retryNotBefore: Date.now() + 1000 });
    h.guardRecoveryStep.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await h.run()).toMatchObject({ execution_status: 'paused' });
    expect(h.spawnSilentContinueStep).not.toHaveBeenCalled();
  });

  it('does not respawn arbitrary errors or expose their internal path', async () => {
    const h = setup();
    h.processAssistantTurn.mockRejectedValue(new Error('FatalError: step//internal/private/assistant-turn'));
    const result = await h.run();
    expect(result).toMatchObject({ execution_status: 'failed', assistant_response: ASSISTANT_FAILURE_MESSAGE });
    expect(JSON.stringify(result)).not.toContain('step//internal');
    expect(h.spawnSilentContinueStep).not.toHaveBeenCalled();
  });
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
    expect(h.completeUserMessageStep).toHaveBeenCalledWith('user-log', 0);
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
    expect(h.pauseUserMessageStep).toHaveBeenCalledWith('user-log', 0);
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

  it('delivers uncertain last-tool context to the model without adding invented tool replies', async () => {
    const h = setup();
    h.prepareRecoveryStep.mockResolvedValue({ ok: true, snapshot: {
      execution: h.execution, respawnCount: 1, messages: h.transcript,
      continuation: { responseNodeIds: ['response'] }, interruptionContext: 'Interrupted: inspect last content update before repeating it',
    } });
    h.processAssistantTurn.mockImplementation(async (context, messages) => {
      expect(context.systemPrompt).toContain('inspect last content update');
      expect(messages).toEqual(h.transcript);
      return h.result(messages, 'Continued from current state', true);
    });
    await h.run({ silentContinue: true, userMessageLogId: 'user-log', resumeToken: 'token' });
    expect(h.completeUserMessageStep).toHaveBeenCalledWith('user-log', 1);
  });

  it('does not let a late abandoned worker failure mark the continuation failed', async () => {
    const h = setup();
    h.processAssistantTurn.mockRejectedValue(new Error('late provider error'));
    h.guardRecoveryStep.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect((await h.run()).success).toBe(false);
    expect(h.markAssistantFailedStep).not.toHaveBeenCalled();
  });

  it.each(['node', 'direct', 'harness'])('cancellation after a terminal checkpoint prevents %s plan lookup and completion', async mode => {
    const h = setup();
    if (mode !== 'node') h.context.instanceNodeId = undefined;
    h.processAssistantTurn.mockResolvedValue(h.result(h.transcript, 'Done', true));
    h.guardRecoveryStep.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await h.run({ userMessageLogId: 'user-log', ...(mode !== 'node' ? { executionMode: mode } : {}) }))
      .toMatchObject({ execution_status: 'paused' });
    expect(h.checkpointRecoveryStep).toHaveBeenCalledTimes(1);
    expect(h.getActiveInstancePlan).not.toHaveBeenCalled();
    expect(h.completeUserMessageStep).not.toHaveBeenCalled();
  });

  it('uses only one guard between a direct terminal checkpoint and completion', async () => {
    const h = setup();
    h.context.instanceNodeId = undefined;
    h.processAssistantTurn.mockResolvedValue(h.result(h.transcript, 'Done', true));
    await h.run({ userMessageLogId: 'user-log', executionMode: 'direct' });
    expect(h.guardRecoveryStep).toHaveBeenCalledTimes(2); // start turn, then finalize
    expect(h.getActiveInstancePlan).not.toHaveBeenCalled();
    expect(h.completeUserMessageStep).toHaveBeenCalledWith('user-log', 0);
  });

  it('finishes a conversation without dispatching the linked plan even when context linkage is missing', async () => {
    const h = setup();
    const { instanceNodeId: _node, ...conversationExecution } = h.execution;
    h.context.instanceNodeId = undefined;
    h.context.hasLinkedRequirement = false;
    h.getActiveInstancePlan.mockResolvedValue({ id: 'pending-plan', steps: [{ status: 'pending' }] });
    h.prepareRecoveryStep.mockResolvedValue({ ok: true, snapshot: {
      execution: conversationExecution, respawnCount: 1, messages: h.transcript, conversationOnly: true,
    } });
    h.processAssistantTurn.mockImplementation(async (context, messages) => {
      expect(context.conversationRecoveryOnly).toBe(true);
      return { messages, text: 'The requirement remains blocked by platform review.', isDone: true, usage: {} };
    });
    const result = await h.run({ silentContinue: true, userMessageLogId: 'user-log', resumeToken: 'token' });
    expect(result).toMatchObject({ execution_status: 'conversation_completed', managed_work_resumed: false });
    expect(h.completeUserMessageStep).toHaveBeenCalledWith('user-log', 1);
    expect(h.getActiveInstancePlan).not.toHaveBeenCalled();
    expect(h.executePlanStep).not.toHaveBeenCalled();
    expect(h.pauseUserMessageStep).not.toHaveBeenCalled();
  });
});