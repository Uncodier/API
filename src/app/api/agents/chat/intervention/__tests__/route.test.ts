import { POST } from '@/app/api/agents/chat/intervention/route';
import { getConversationChannel, sendMessageByChannel } from '@/app/api/agents/chat/intervention/send-intervention-by-channel';
import { canAccessSite, getRequestSitePrincipal } from '@/lib/security/site-access';
const mockPermission = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: mockPermission }) }));

jest.mock('@/lib/security/site-access', () => ({
  canAccessSite: jest.fn(),
  getRequestSitePrincipal: jest.fn(),
}));
jest.mock('@/lib/security/request-rate-limit', () => ({ hasAuthenticatedPrincipal: () => true }));

jest.mock('uuid', () => ({
  v4: () => 'intervention-uuid',
}));

const fromMock = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

jest.mock('@/app/api/agents/chat/intervention/send-intervention-by-channel', () => ({
  getConversationChannel: jest.fn(),
  sendMessageByChannel: jest.fn(),
}));

function createChain(result: { data?: any; error?: any } = { data: null, error: null }) {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.eq = jest.fn().mockReturnValue(chain);
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  chain.limit = jest.fn().mockResolvedValue({ data: [], error: null });
  return chain;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONV_ID = '22222222-2222-4222-8222-222222222222';
const MSG_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';

describe('POST /api/agents/chat/intervention', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (canAccessSite as jest.Mock).mockResolvedValue(true);
    mockPermission.mockResolvedValue({ data: true, error: null });
    (getRequestSitePrincipal as jest.Mock).mockReturnValue({ userId: USER_ID, siteId: null, internal: false });

    const conversations = createChain({ data: { id: CONV_ID, site_id: SITE_ID }, error: null });
    const messages = createChain({ data: { id: MSG_ID }, error: null });
    fromMock.mockImplementation((table: string) => (table === 'messages' ? messages : conversations));

    (getConversationChannel as jest.Mock).mockResolvedValue({
      channel: 'whatsapp',
      leadPhone: '+15551234567',
    });
    (sendMessageByChannel as jest.Mock).mockResolvedValue({
      success: true,
      method: 'whatsapp',
      workflowId: 'wf-started',
      workflowStarted: true,
    });
  });

  it('returns 200 accepted with message_id and workflowId without waiting for delivery', async () => {
    const request = new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-session' },
      body: JSON.stringify({
        conversationId: CONV_ID,
        message: 'Hello from the team',
        user_id: USER_ID,
        site_id: SITE_ID,
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('accepted');
    expect(body.data.message.message_id).toBe(MSG_ID);
    expect(body.data.channel_send.workflowId).toBe('wf-started');
    expect(sendMessageByChannel).toHaveBeenCalledTimes(1);
    expect(fromMock).toHaveBeenCalledWith('messages');
    const messagesChain = fromMock.mock.results.find((_, i) => fromMock.mock.calls[i][0] === 'messages')?.value;
    expect(messagesChain.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        custom_data: { command_status: 'pending', status: 'pending' },
        content: 'Hello from the team',
        role: 'team_member',
      }),
    ]);
  });

  it('returns 200 with channel_send.success false when Temporal never starts (missing phone)', async () => {
    (sendMessageByChannel as jest.Mock).mockResolvedValue({
      success: false,
      method: 'whatsapp',
      workflowStarted: false,
      reason: 'missing_contact',
      error: 'No se encontró número de teléfono para envío por WhatsApp',
    });

    const request = new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-session' },
      body: JSON.stringify({
        conversationId: CONV_ID,
        message: 'Hello from the team',
        user_id: USER_ID,
        site_id: SITE_ID,
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.channel_send.success).toBe(false);
    expect(body.data.channel_send.workflowId).toBeUndefined();
  });

  it('returns 500 when Temporal start fails after the row is saved', async () => {
    (sendMessageByChannel as jest.Mock).mockResolvedValue({
      success: false,
      method: 'whatsapp',
      workflowStarted: false,
      reason: 'workflow_start_failed',
      error: 'Temporal unavailable',
    });

    const request = new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-session' },
      body: JSON.stringify({
        conversationId: CONV_ID,
        message: 'Hello from the team',
        user_id: USER_ID,
        site_id: SITE_ID,
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.data.message_id).toBe(MSG_ID);
  });

  it.each([true, false])('retains the saved row and unknown outcome regardless of delivery flag %s', async (channelDelivery) => {
    (getConversationChannel as jest.Mock).mockResolvedValue({ channel: 'voice', channelDelivery });
    (sendMessageByChannel as jest.Mock).mockResolvedValue({
      success: false, method: 'voice_agent_call', delivery_status: 'placement_unknown', reason: 'placement_unknown',
    });
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' }, body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', site_id: SITE_ID }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, data: {
      message: { message_id: MSG_ID },
      channel_send: { success: false, method: 'voice_agent_call', delivery_status: 'placement_unknown' },
    } });
  });

  it('returns accepted callId rather than requiring a workflow id', async () => {
    (getConversationChannel as jest.Mock).mockResolvedValue({ channel: 'voice' });
    (sendMessageByChannel as jest.Mock).mockResolvedValue({
      success: true, method: 'voice_agent_call', delivery_status: 'accepted', callId: 'call-1',
    });
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' }, body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', agentId: '' }),
    }));
    expect(await response.json()).toMatchObject({ data: {
      status: 'accepted', channel_send: { callId: 'call-1', delivery_status: 'accepted' },
    } });
  });

  it.each([
    { user_id: SITE_ID }, { site_id: MSG_ID }, { agentId: MSG_ID },
    { lead_id: MSG_ID }, { visitor_id: MSG_ID },
  ])('rejects impersonated or mismatched resources before persistence %j', async (extra) => {
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' }, body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', ...extra }),
    }));
    expect(response.status).toBe(403);
    expect(fromMock.mock.calls.some(([table]) => table === 'messages')).toBe(false);
    expect(sendMessageByChannel).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests before database access', async () => {
    (getRequestSitePrincipal as jest.Mock).mockReturnValue({ userId: null });
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello' }),
    }));
    expect(response.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('requires the session-scoped insert capability before saving', async () => {
    mockPermission.mockResolvedValue({ data: false, error: null });
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello' }),
    }));
    expect(response.status).toBe(403);
    expect(mockPermission).toHaveBeenCalledWith('user_can', { p_site_id: SITE_ID, p_command: 'insert' });
    expect(fromMock.mock.calls.some(([table]) => table === 'messages')).toBe(false);
  });

  it('requires update capability for retries', async () => {
    mockPermission.mockResolvedValue({ data: false, error: null });
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', message_id: MSG_ID }),
    }));
    expect(response.status).toBe(403);
    expect(mockPermission).toHaveBeenCalledWith('user_can', { p_site_id: SITE_ID, p_command: 'update' });
    expect(sendMessageByChannel).not.toHaveBeenCalled();
  });

  it('rejects a read-only API key before privileged access', async () => {
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { 'x-api-key-data': JSON.stringify({ scopes: ['read'] }) },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello' }),
    }));
    expect(response.status).toBe(403);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('denies site membership failures before saving', async () => {
    (canAccessSite as jest.Mock).mockResolvedValue(false);
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello' }),
    }));
    expect(response.status).toBe(403);
    expect(fromMock.mock.calls.some(([table]) => table === 'messages')).toBe(false);
  });

  it('rejects malformed JSON as a client error', async () => {
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', { method: 'POST', body: '{' }));
    expect(response.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });
});
