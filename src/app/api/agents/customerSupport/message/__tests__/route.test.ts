import { POST } from '../route';
import { generateSupportReply } from '../generate';
import { saveMessages } from '../save-messages';
import { getCommandById } from '@/lib/database/command-db';

jest.mock('../request', () => ({ readSupportRequest: async (r: Request) => ({ body: await r.json() }) }));
jest.mock('../zavu-admission', () => ({ checkZavuSupportAdmission: async () => null }));
jest.mock('../context', () => ({ buildSupportContext: async () => 'context' }));
jest.mock('../generate', () => ({ generateSupportReply: jest.fn() }));
jest.mock('../save-messages', () => ({ saveMessages: jest.fn() }));
jest.mock('../agent-data', () => ({
  isValidUUID: (id: string) => /^[0-9a-f-]{36}$/.test(id),
  getAgentInfo: async () => ({ user_id: 'user' }),
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
    jest.mocked(generateSupportReply).mockResolvedValue({
      executedCommand: { id: commandId, status: 'completed', results: [] }, effectiveDbUuid: commandId,
    } as any);
    jest.mocked(saveMessages).mockResolvedValue({ conversationId: 'conversation', userMessageId: 'in', assistantMessageId: 'out' } as any);
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