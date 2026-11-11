import { POST } from '../route';
import { buildSupportContext } from '../context';
import { generateSupportReply } from '../generate';
import { saveMessages } from '../save-messages';
import { getCommandById } from '@/lib/database/command-db';
import { getAgentInfo, findActiveCustomerSupportAgent } from '../agent-data';
import { readSupportSnooze, saveSnoozedSupportInput } from '../snooze';
import { saveZavuSupportMessages } from '../save-zavu-messages';
import { reconcileConversationHumanEvents } from '@/lib/services/zavu/conversation-automation-contact';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';

jest.mock('../request', () => ({ readSupportRequest: async (r: Request) => ({ body: await r.json() }) }));
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async () => undefined) }));
jest.mock('../zavu-admission', () => ({ checkZavuSupportAdmission: async () => null }));
jest.mock('../context', () => ({ buildSupportContext: jest.fn(async () => 'context') }));
jest.mock('../generate', () => ({ generateSupportReply: jest.fn() }));
jest.mock('../save-messages', () => ({ saveMessages: jest.fn() }));
jest.mock('@/lib/services/zavu/conversation-automation-contact', () => ({
  reconcileConversationHumanEvents: jest.fn(async () => undefined),
}));
jest.mock('../save-zavu-messages', () => ({ saveZavuSupportMessages: jest.fn(async (input) => ({
  conversationId: input.conversationId, userMessageId: 'in',
})) }));
jest.mock('../snooze', () => ({
  resolveSnoozeConversation: jest.fn(async (input) => input.conversationId),
  readSupportSnooze: jest.fn(async () => null),
  saveSnoozedSupportInput: jest.fn(async (input, state) => ({ success: true, data: {
    automation_paused: true, skipped: true, response_skipped: true, reason: 'agent_snoozed',
    automation_paused_until: state.pausedUntil, conversation_id: state.conversationId,
    messages: { user: { content: input.message, message_id: 'in' } },
  } })),
}));
jest.mock('../disabled-support', () => ({ disabledSupportNote: async () => 'Agente deshabilitado. No se generó respuesta.' }));
jest.mock('../agent-data', () => ({
  isValidUUID: (id: string) => /^[0-9a-f-]{36}$/.test(id),
  getAgentInfo: jest.fn(async () => ({ user_id: 'user', status: 'active' })),
  findActiveCustomerSupportAgent: jest.fn(async () => null),
}));
jest.mock('@/lib/database/command-db', () => ({ getCommandById: jest.fn() }));
jest.mock('@/lib/services/leads/lead-service', () => ({ manageLeadCreation: async () => ({ leadId: null }) }));
jest.mock('@/lib/services/leads/outstand-comment-identity', () => ({ OutstandLeadIdentityError: class extends Error {} }));
jest.mock('@/lib/services/whatsapp/WhatsAppLeadService', () => ({ WhatsAppLeadService: {} }));
jest.mock('@/lib/services/conversation-service', () => ({ ConversationService: {} }));
jest.mock('@/lib/services/visitor-identity/VisitorSessionAuthorizationService', () => ({ visitorAuthorizationErrorResponse: () => null }));
jest.mock('@/lib/services/social-comments/conversations', () => ({}));

const commandId = '00000000-0000-4000-8000-000000000001';
const agentId = '00000000-0000-4000-8000-000000000002';
const request = () => new Request('https://example.test/api/agents/customerSupport/message', {
  method: 'POST', body: JSON.stringify({ userId: 'user', agentId, site_id: 'site',
    conversationId: 'conversation', message: 'Hola', origin: 'whatsapp' }),
});
const fresh = { id: commandId, status: 'completed', site_id: 'site', agent_id: agentId,
  user_id: 'user', results: [{ message: { content: 'Hola, bienvenido' } }] };
// Jest otherwise selects the last (assistant-producing) overload. These mocks
// represent only the route's initial inbound-only persistence boundary.
type InboundSaver = (input: Omit<Parameters<typeof saveZavuSupportMessages>[0], 'inboundOnly'> & { inboundOnly: true }) => Promise<{
  conversationId: string; userMessageId: string; assistantMessageId: undefined; automationStartedAt: string;
}>;
const saveInboundMock = saveZavuSupportMessages as unknown as jest.MockedFunction<InboundSaver>;
const inboundResult = (conversationId: string) => ({ conversationId, userMessageId: 'in',
  assistantMessageId: undefined, automationStartedAt: '2026-11-11T12:00:00Z' });

describe('support route persistence boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(readSupportSnooze).mockReset().mockResolvedValue(null);
    jest.mocked(reconcileConversationHumanEvents).mockReset().mockResolvedValue(undefined);
    saveInboundMock.mockReset().mockImplementation(async input => inboundResult(input.conversationId!));
    jest.mocked(getAgentInfo).mockResolvedValue({ user_id: 'user', status: 'active' });
    jest.mocked(findActiveCustomerSupportAgent).mockResolvedValue(null);
    jest.mocked(generateSupportReply).mockResolvedValue({
      executedCommand: { id: commandId, status: 'completed', results: [] }, effectiveDbUuid: commandId,
    } as any);
    jest.mocked(saveMessages).mockResolvedValue({ conversationId: 'conversation', userMessageId: 'in', assistantMessageId: 'out' } as any);
  });

  it('preserves inbound while snoozed without generating or returning an assistant reply', async () => {
    jest.mocked(readSupportSnooze).mockResolvedValue({ conversationId: 'conversation', pausedUntil: '2030-01-01T12:00:00Z' });
    const response = await POST(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ automation_paused: true, skipped: true, reason: 'agent_snoozed' });
    expect(body.data.messages.assistant).toBeUndefined();
    expect(saveSnoozedSupportInput).toHaveBeenCalledTimes(1);
    expect(buildSupportContext).not.toHaveBeenCalled();
    expect(generateSupportReply).not.toHaveBeenCalled();
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it('discards a reply when a human intervenes during generation', async () => {
    jest.mocked(getCommandById).mockResolvedValue(fresh as any);
    jest.mocked(readSupportSnooze).mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ conversationId: 'conversation', pausedUntil: '2030-01-01T12:00:00Z' });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).data.messages.assistant).toBeUndefined();
    expect(generateSupportReply).toHaveBeenCalledTimes(1);
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it('persists disabled inbound messages successfully without any sendable reply', async () => {
    jest.mocked(getAgentInfo).mockResolvedValue({ user_id: 'user', status: 'inactive' });
    const response = await POST(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, data: {
      agent_disabled: true, response_skipped: true, conversation_id: 'conversation',
      lead_id: null, task_id: null, messages: { user: { content: 'Hola', message_id: 'in' } },
    } });
    expect(body.message).toBeUndefined();
    expect(body.data.messages.assistant).toBeUndefined();
    expect(generateSupportReply).not.toHaveBeenCalled();
    expect(getCommandById).not.toHaveBeenCalled();
    expect(saveMessages).toHaveBeenCalledTimes(1);
    expect(jest.mocked(saveMessages).mock.calls[0][18]).toBe(true);
  });

  it('does not report success when disabled persistence fails', async () => {
    jest.mocked(getAgentInfo).mockResolvedValue({ user_id: 'user', status: 'inactive' });
    jest.mocked(saveMessages).mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect((await response.json()).success).toBe(false);
    expect(generateSupportReply).not.toHaveBeenCalled();
  });

  it('does not classify an active-agent database failure as disabled', async () => {
    jest.mocked(findActiveCustomerSupportAgent).mockRejectedValueOnce(new Error('database unavailable'));
    const response = await POST(new Request('https://example.test/api/agents/customerSupport/message', {
      method: 'POST', body: JSON.stringify({ userId: 'user', site_id: 'site',
        conversationId: 'conversation', message: 'Hola', origin: 'whatsapp' }),
    }));
    expect(response.status).toBe(500);
    expect((await response.json()).data).toBeUndefined();
    expect(saveMessages).not.toHaveBeenCalled();
    expect(generateSupportReply).not.toHaveBeenCalled();
  });

  it('does not generate or persist after an explicit-agent lookup failure', async () => {
    jest.mocked(getAgentInfo).mockRejectedValueOnce(new Error('database unavailable'));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect((await response.json()).data).toBeUndefined();
    expect(saveMessages).not.toHaveBeenCalled();
    expect(generateSupportReply).not.toHaveBeenCalled();
  });

  it('recovers the exact command and saves only the real response', async () => {
    jest.mocked(getCommandById).mockResolvedValue(fresh as any);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(getCommandById).toHaveBeenCalledWith(commandId);
    expect(saveMessages).toHaveBeenCalledTimes(1);
    expect(jest.mocked(saveMessages).mock.calls[0][2]).toBe('Hola, bienvenido');
    expect((await response.json()).data.messages.assistant.content).toBe('Hola, bienvenido');
  });

  it.each(['image', 'video', 'audio', 'document'])('returns and saves the selected existing %s media without generation dispatch', async message_type => {
    const media = { message_type, media_url: 'https://media.example.test/file',
      mime_type: message_type === 'document' ? 'application/pdf' : `${message_type}/test` };
    jest.mocked(generateSupportReply).mockResolvedValue({ effectiveDbUuid: commandId,
      executedCommand: { results: [{ message: { content: '', response_format: 'text', ...media } }] } } as any);
    const response = await POST(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ ...media, response_format: 'text' });
    expect(body.data.messages.assistant).toMatchObject({ ...media, response_format: 'text', content: '' });
    expect(jest.mocked(saveMessages).mock.calls[0][20]).toEqual(media);
    expect(assertSafeRemoteUrl).toHaveBeenCalledWith(media.media_url);
    expect(getCommandById).not.toHaveBeenCalled();
  });

  it.each(['conflict', 'unsafe'])('does not persist invalid selected media (%s)', async reason => {
    jest.mocked(generateSupportReply).mockResolvedValue({ effectiveDbUuid: commandId,
      executedCommand: { results: [{ message: { content: 'Reply', message_type: 'image',
        media_url: 'https://media.example.test/file', response_format: reason === 'conflict' ? 'audio' : 'text' } }] } } as any);
    if (reason === 'unsafe') jest.mocked(assertSafeRemoteUrl).mockRejectedValueOnce(new Error('private address'));
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('CUSTOMER_SUPPORT_INVALID_MEDIA');
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it('forwards current inbound routing metadata to the per-turn context and generator', async () => {
    jest.mocked(getCommandById).mockResolvedValue(fresh as any);
    const custom_data = { source: 'zavu_inbound_message', channel: 'telegram', zavu_from: '@customer',
      connection_id: 'connection', zavu_sender_id: 'business' };
    const response = await POST(new Request('https://example.test/api/agents/customerSupport/message', {
      method: 'POST', body: JSON.stringify({ userId: 'user', agentId, site_id: 'site',
        conversationId: 'conversation', message: 'Hello', origin: 'telegram', origin_message_id: 'provider-in', custom_data }),
    }));
    expect(response.status).toBe(200);
    expect(buildSupportContext).toHaveBeenCalledWith(expect.objectContaining({
      custom_data, effectiveOrigin: 'telegram', effectiveConversationId: 'conversation',
    }));
    expect(generateSupportReply).toHaveBeenCalledWith(expect.objectContaining({ contextMessage: 'context' }));
    expect(saveZavuSupportMessages).toHaveBeenCalledWith(expect.objectContaining({ inboundOnly: true,
      originMessageId: 'provider-in', assistantMessage: '' }));
    expect(jest.mocked(saveZavuSupportMessages).mock.invocationCallOrder[0])
      .toBeLessThan(jest.mocked(generateSupportReply).mock.invocationCallOrder[0]);
    expect(reconcileConversationHumanEvents).not.toHaveBeenCalled();
  });

  const whatsappMetadata = { source: 'zavu_inbound_message', channel: 'whatsapp',
    connection_id: 'connection', zavu_sender_id: 'sender', zavu_from: 'whatsapp:+15555550123' };
  const firstInbound = () => new Request('https://example.test/api/agents/customerSupport/message', {
    method: 'POST', body: JSON.stringify({ userId: 'user', agentId, site_id: 'site',
      message: 'Hello', origin: 'whatsapp', origin_message_id: 'provider-in', custom_data: whatsappMetadata }),
  });

  it('reconciles the first inbound after saving and before snooze read, suppressing all model work', async () => {
    saveInboundMock.mockResolvedValue(inboundResult('new-conversation'));
    let reconciled = false;
    jest.mocked(reconcileConversationHumanEvents).mockImplementation(async () => { reconciled = true; });
    jest.mocked(readSupportSnooze).mockImplementation(async () => reconciled
      ? { conversationId: 'new-conversation', pausedUntil: '2030-01-01T12:00:00Z' } : null);
    const response = await POST(firstInbound());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ automation_paused: true, skipped: true, response_skipped: true,
      conversation_id: 'new-conversation', reason: 'agent_snoozed' });
    expect(body.data.messages.assistant).toBeUndefined();
    expect(saveZavuSupportMessages).toHaveBeenCalledWith(expect.objectContaining({ inboundOnly: true, assistantMessage: '' }));
    expect(reconcileConversationHumanEvents).toHaveBeenCalledWith({ siteId: 'site',
      conversationId: 'new-conversation', metadata: whatsappMetadata });
    expect(jest.mocked(saveZavuSupportMessages).mock.invocationCallOrder[0])
      .toBeLessThan(jest.mocked(reconcileConversationHumanEvents).mock.invocationCallOrder[0]);
    expect(jest.mocked(reconcileConversationHumanEvents).mock.invocationCallOrder[0])
      .toBeLessThan(jest.mocked(readSupportSnooze).mock.invocationCallOrder[0]);
    expect(saveSnoozedSupportInput).toHaveBeenCalledWith(expect.objectContaining({ persistedInboundId: 'in' }), expect.anything());
    expect(buildSupportContext).not.toHaveBeenCalled();
    expect(generateSupportReply).not.toHaveBeenCalled();
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it('fails closed before snooze/model work if first-contact reconciliation fails', async () => {
    saveInboundMock.mockResolvedValue(inboundResult('new-conversation'));
    jest.mocked(reconcileConversationHumanEvents).mockRejectedValue(new Error('CUSTOMER_SUPPORT_SNOOZE_RECONCILIATION_FAILED'));
    const response = await POST(firstInbound());
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect((await response.json()).data).toBeUndefined();
    expect(saveZavuSupportMessages).toHaveBeenCalledTimes(1);
    expect(readSupportSnooze).not.toHaveBeenCalled();
    expect(buildSupportContext).not.toHaveBeenCalled();
    expect(generateSupportReply).not.toHaveBeenCalled();
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it('does not reconcile if the inbound could not be durably saved', async () => {
    jest.mocked(saveZavuSupportMessages).mockRejectedValue(new Error('inbound save unavailable'));
    const response = await POST(firstInbound());
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(reconcileConversationHumanEvents).not.toHaveBeenCalled();
    expect(readSupportSnooze).not.toHaveBeenCalled();
    expect(generateSupportReply).not.toHaveBeenCalled();
  });

  it.each([
    ['whatsapp', undefined, 'audio', 'audio'],
    ['telegram', undefined, 'audio', 'audio'],
    ['messenger', undefined, 'audio', 'audio'],
    ['whatsapp', 'text', 'audio', 'text'],
    ['telegram', 'audio', 'text', 'audio'],
    ['email', undefined, 'audio', 'text'],
    ['website', 'text', 'audio', 'text'],
    ['whatsapp', undefined, undefined, 'text'],
  ])('returns and saves selected format on %s (explicit %s, model %s)', async (origin, explicit, model, expected) => {
    jest.mocked(generateSupportReply).mockResolvedValue({ executedCommand: {
      ...fresh, results: [{ message: { content: 'Spoken reply', response_format: model } }],
    }, effectiveDbUuid: commandId } as any);
    const response = await POST(new Request('https://example.test/api/agents/customerSupport/message', {
      method: 'POST', body: JSON.stringify({ userId: 'user', agentId, site_id: 'site',
        conversationId: 'conversation', message: 'Hola', origin, response_format: explicit }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.response_format).toBe(expected);
    expect(body.data.messages.assistant).toMatchObject({ content: 'Spoken reply', response_format: expected, message_id: 'out' });
    expect(body.data.messages.assistant.audio_url).toBeUndefined();
    expect(jest.mocked(saveMessages).mock.calls[0][19]).toBe(expected);
    expect(buildSupportContext).toHaveBeenCalledWith(expect.objectContaining({ response_format: explicit }));
    expect(generateSupportReply).toHaveBeenCalledWith(expect.objectContaining({ response_format: explicit }));
  });

  it.each([
    ['whatsapp', 'video'], ['whatsapp', null], ['whatsapp', {}],
    ['website', 'audio'], ['email', 'audio'], ['instagram', 'audio'],
  ])('rejects explicit unsupported/invalid %s %s before generation', async (origin, response_format) => {
    const response = await POST(new Request('https://example.test/api/agents/customerSupport/message', {
      method: 'POST', body: JSON.stringify({ userId: 'user', agentId, site_id: 'site',
        conversationId: 'conversation', message: 'Hola', origin, response_format }),
    }));
    expect(response.status).toBe(400);
    expect(buildSupportContext).not.toHaveBeenCalled();
    expect(generateSupportReply).not.toHaveBeenCalled();
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it('rejects oversized explicit audio without saving or returning sendable content', async () => {
    jest.mocked(generateSupportReply).mockResolvedValue({ executedCommand: {
      ...fresh, results: [{ message: { content: 'x'.repeat(4001), response_format: 'audio' } }],
    }, effectiveDbUuid: commandId } as any);
    const response = await POST(new Request('https://example.test/api/agents/customerSupport/message', {
      method: 'POST', body: JSON.stringify({ userId: 'user', agentId, site_id: 'site',
        conversationId: 'conversation', message: 'Hola', origin: 'telegram', response_format: 'audio' }),
    }));
    expect(response.status).toBe(422);
    expect((await response.json()).data).toBeUndefined();
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...fresh, results: [] },
    { ...fresh, results: [{ message: { content: 'No response generated' } }] },
    { ...fresh, site_id: 'other-site' },
    { ...fresh, agent_id: 'other-agent' },
    { ...fresh, user_id: 'other-user' },
    { ...fresh, id: 'other-command' },
  ])('returns retryable failure without saving or returning a placeholder %#', async command => {
    jest.mocked(getCommandById).mockResolvedValue(command as any);
    const response = await POST(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('CUSTOMER_SUPPORT_EMPTY_RESPONSE');
    expect(body.data).toBeUndefined();
    expect(saveMessages).not.toHaveBeenCalled();
    expect(generateSupportReply).toHaveBeenCalledTimes(1);
  });
});