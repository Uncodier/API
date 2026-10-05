import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { recoveryDatabase, scope } from '@/lib/services/robot-instance/test-support/assistant-recovery-fixture';

type AsyncMock = (...args: any[]) => Promise<any>;
let database: ReturnType<typeof recoveryDatabase>;
const model = jest.fn<AsyncMock>();
const prepare = jest.fn<AsyncMock>();
const persist = jest.fn<AsyncMock>();
const complete = jest.fn<AsyncMock>();
const send = jest.fn<AsyncMock>();
const sendError = jest.fn<AsyncMock>();
const typing = jest.fn<AsyncMock>();
const lobby = jest.fn<AsyncMock>();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: (table: string) => database.from(table) },
}));
jest.unstable_mockModule('@/app/api/robots/instance/assistant/assistant-turn', () => ({ processAssistantTurn: model }));
jest.unstable_mockModule('@/app/api/robots/instance/assistant/steps', () => ({ prepareAssistantContext: prepare }));
jest.unstable_mockModule('@/app/api/robots/instance/assistant/plan-steps', () => ({
  getActiveInstancePlan: async () => null,
  executePlanStep: jest.fn(), acquirePlanExecutionLockStep: jest.fn(), releasePlanExecutionLockStep: jest.fn(),
}));
jest.unstable_mockModule('@/app/api/robots/instance/assistant/persist-and-fail-steps', () => ({
  persistUserMessageStep: persist, completeUserMessageStep: complete,
  pauseUserMessageStep: jest.fn(), markAssistantFailedStep: jest.fn(),
}));
jest.unstable_mockModule('@/app/api/robots/instance/assistant/assistant-respawn-steps', () => ({ spawnSilentContinueStep: jest.fn() }));
jest.unstable_mockModule('../steps', () => ({
  sendWhatsAppResponse: send, sendWhatsAppError: sendError, sendWhatsAppTypingIndicator: typing,
  processUnregisteredUserStep: lobby,
}));

let run: typeof import('../workflow').runGearAgentWorkflow;
let runLobby: typeof import('../workflow').runUnregisteredGearAgentWorkflow;
beforeAll(async () => { ({ runGearAgentWorkflow: run, runUnregisteredGearAgentWorkflow: runLobby } = await import('../workflow')); });
const message = 'Consulta el estado';
const input = {
  instanceId: scope.instanceId, siteId: scope.siteId, userId: scope.userId,
  message, messageSid: 'message-current', userPhone: '+15555550100',
  userMessageLogId: scope.userMessageLogId,
};
beforeEach(() => {
  jest.clearAllMocks();
  database = recoveryDatabase();
  database.action().message = message;
  database.action().details.message_sid = input.messageSid;
  // A previous identical request can be returned by the old, unordered text lookup.
  database.tables.instance_logs.push({
    ...database.action(), id: 'previous-action', created_at: '2026-09-30T11:59:45Z',
    details: { status: 'completed', message_sid: 'message-previous' },
  });
  persist.mockResolvedValue({ id: 'previous-action' });
  send.mockResolvedValue(true);
  prepare.mockResolvedValue({ instance: { status: 'running' }, initialMessage: message, hasLinkedRequirement: false });
  model.mockImplementation(async (_context, messages) => ({
    messages: [...messages, { role: 'assistant', content: 'Estado consultado' }],
    text: 'Estado consultado', isDone: true, usage: {},
  }));
  complete.mockImplementation(async () => { database.action().details.status = 'completed'; });
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected live request'));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('Gear WhatsApp assistant recovery binding', () => {
  it('executes a new repeated message using its own action, never rediscovering the old action by text', async () => {
    const result = await run(input);
    expect(result).toMatchObject({ success: true, assistant_response: 'Estado consultado' });
    expect(persist).not.toHaveBeenCalled();
    expect(model).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(
      scope.instanceId, message, scope.siteId, scope.userId, [], false,
      undefined, 'gear', input.userPhone, undefined, undefined, undefined, undefined, undefined, undefined,
    );
    expect(database.snapshot().execution).toMatchObject({ agentType: 'gear', userPhone: input.userPhone });
    expect(database.snapshot().messages).toContainEqual({ role: 'assistant', content: 'Estado consultado' });
    expect(complete).toHaveBeenCalledWith(scope.userMessageLogId, 0);
    expect(database.tables.instance_logs[1].details).toEqual({ status: 'completed', message_sid: 'message-previous' });
    expect(send).toHaveBeenCalledWith(input.userPhone, 'Estado consultado', input.siteId, undefined, scope);
    expect(sendError).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'stopped', 'completed'])('preserves the safety stop for an action that is %s', async status => {
    database.action().details.status = status;
    const result = await run(input);
    expect(result).toMatchObject({ success: false, execution_status: 'paused' });
    expect(persist).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(database.action().details.status).toBe(status);
    expect(result.assistant_response).toContain('cannot continue safely');
    expect(send).not.toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
  });

  it('does not resurrect an action superseded by a newer WhatsApp message', async () => {
    database.tables.instance_logs.push({ ...database.action(), id: 'newer-action', created_at: '2026-09-30T12:00:10Z' });
    expect(await run(input)).toMatchObject({ success: false, execution_status: 'paused' });
    expect(model).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
  });

  it('does not replace a missing bound action with a newly persisted action', async () => {
    database.tables.instance_logs.shift();
    expect(await run(input)).toMatchObject({ success: false, execution_status: 'paused' });
    expect(persist).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
  });

  it('retains the legacy workflow fallback for already queued inputs without an action ID', async () => {
    persist.mockResolvedValue({ id: scope.userMessageLogId });
    const { userMessageLogId: _id, ...legacyInput } = input;
    expect(await run(legacyInput)).toMatchObject({ success: true });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(model).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(input.userPhone, 'Estado consultado', input.siteId, undefined, undefined);
  });

  it('keeps the original internal error without sending a generic error reply', async () => {
    const error = new Error('Provider unavailable');
    model.mockRejectedValueOnce(error);
    await expect(run(input)).rejects.toBe(error);
    expect(send).not.toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
  });

  it('does not append an error message or replay a failed outbound send', async () => {
    const error = new Error('Delivery outcome unknown');
    send.mockRejectedValueOnce(error);
    await expect(run(input)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sendError).not.toHaveBeenCalled();
  });

  it('never sends a stale answer when a new message arrives during the model turn', async () => {
    model.mockImplementationOnce(async (_context, messages) => {
      database.tables.instance_logs.push({ ...database.action(), id: 'new-action', created_at: '2026-09-30T12:00:10Z' });
      return { messages, text: 'Outdated answer', isDone: true, usage: {} };
    });
    expect(await run(input)).toMatchObject({ success: false, execution_status: 'paused' });
    expect(send).not.toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
  });

  it('also suppresses generic errors in the unregistered/lobby workflow', async () => {
    const error = new Error('Lobby failed');
    lobby.mockRejectedValueOnce(error);
    await expect(runLobby({ message, siteId: input.siteId, userPhone: input.userPhone,
      businessAccountId: 'business', systemPrompt: 'Lobby' })).rejects.toBe(error);
    expect(sendError).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});