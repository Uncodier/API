import { POST } from '../route';
import { generateSupportReply } from '../generate';
import { saveMessages } from '../save-messages';
import { getCommandById } from '@/lib/database/command-db';
import { getAgentInfo, findActiveCustomerSupportAgent } from '../agent-data';

jest.mock('../request', () => ({ readSupportRequest: async (r: Request) => ({ body: await r.json() }) }));
jest.mock('../zavu-admission', () => ({ checkZavuSupportAdmission: async () => null }));
jest.mock('../context', () => ({ buildSupportContext: async () => 'context' }));
jest.mock('../generate', () => ({ generateSupportReply: jest.fn() }));
jest.mock('../save-messages', () => ({ saveMessages: jest.fn() }));
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

describe('support route persistence boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getAgentInfo).mockResolvedValue({ user_id: 'user', status: 'active' });
    jest.mocked(findActiveCustomerSupportAgent).mockResolvedValue(null);
    jest.mocked(generateSupportReply).mockResolvedValue({
      executedCommand: { id: commandId, status: 'completed', results: [] }, effectiveDbUuid: commandId,
    } as any);
    jest.mocked(saveMessages).mockResolvedValue({ conversationId: 'conversation', userMessageId: 'in', assistantMessageId: 'out' } as any);
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