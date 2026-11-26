import { POST } from '@/app/api/agents/chat/intervention/route';
import { randomBytes } from 'node:crypto';
import { getConversationChannel, sendMessageByChannel } from '@/app/api/agents/chat/intervention/send-intervention-by-channel';
import { canAccessSite, getRequestSitePrincipal } from '@/lib/security/site-access';
import { AudioRoutingError, resolveAudioRouting } from '@/lib/services/channels/audio-routing';
jest.mock('@/lib/services/channels/audio-routing', () => ({
  ...jest.requireActual('@/lib/services/channels/audio-routing'), resolveAudioRouting: jest.fn(),
}));
const mockPermission = jest.fn();
const mockSupplierRead = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: mockPermission, from: mockSupplierRead }) }));

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
  // The permission client is mocked; never depend on a developer's Supabase env.
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = randomBytes(24).toString('hex');
  });
  afterAll(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    (resolveAudioRouting as jest.Mock).mockResolvedValue({ kind: 'zavu', connectionId: 'selected-second', senderId: 'sender-second' });
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

  it.each([true, false])('dispatches only a supplier contact readable at the saved version (%s)', async readable => {
    const supplier_id = '55555555-5555-4555-8555-555555555555';
    const contact_id = '66666666-6666-4666-8666-666666666666';
    const supplier = createChain({ data: readable ? { supplier_contacts: [{ id: contact_id, email: 'supplier@example.test' }] } : null });
    const conversation = createChain({ data: { id: CONV_ID, site_id: SITE_ID, channel: 'email',
      custom_data: { supplier_target: { supplier_id, contact_id, version: 4, channel: 'email' } } } });
    const messages = createChain({ data: { id: MSG_ID } });
    mockSupplierRead.mockReturnValue(supplier);
    fromMock.mockImplementation((table: string) => table === 'messages' ? messages : conversation);
    const response = await POST(new Request('https://api.example.test/intervention', { method: 'POST',
      headers: { authorization: `Bearer ${randomBytes(24).toString('hex')}` },
      body: JSON.stringify({ conversation_id: CONV_ID, message: 'Order update', response_format: 'text' }) }));
    expect(supplier.eq).toHaveBeenCalledWith('site_id', SITE_ID);
    expect(supplier.eq).toHaveBeenCalledWith('version', 4);
    expect(getConversationChannel).not.toHaveBeenCalled();
    if (readable) {
      expect(response.status).toBe(200);
      expect(sendMessageByChannel).toHaveBeenCalledWith('email', 'Order update', expect.objectContaining({ leadEmail: 'supplier@example.test' }),
        SITE_ID, undefined, CONV_ID, undefined, MSG_ID, 'text', expect.any(Object));
    } else {
      expect(response.status).toBe(409);
      expect(messages.insert).not.toHaveBeenCalled();
      expect(sendMessageByChannel).not.toHaveBeenCalled();
    }
  });

  it('refuses an external intervention on an internal review conversation', async () => {
    fromMock.mockReturnValue(createChain({ data: {id:CONV_ID, site_id:SITE_ID, channel:'internal_review'}, error:null }));
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method:'POST', headers:{Authorization:'Bearer test-session'}, body:JSON.stringify({conversationId:CONV_ID,message:'Hello'}),
    }));
    expect(response.status).toBe(403);
    expect(sendMessageByChannel).not.toHaveBeenCalled();
  });

  it.each(['whatsapp', 'telegram', 'messenger'])('persists and forwards explicit audio on %s', async (channel) => {
    (getConversationChannel as jest.Mock).mockResolvedValue({ channel, leadPhone: '+15551234567' });
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', response_format: 'audio' }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.message.custom_data.response_format).toBe('audio');
    const messages = fromMock.mock.results.find((_, i) => fromMock.mock.calls[i][0] === 'messages')!.value;
    expect(messages.insert).toHaveBeenCalledWith([expect.objectContaining({
      custom_data: { command_status: 'pending', status: 'accepted', dispatch_owner: 'chat_intervention', response_format: 'audio', connection_id: 'selected-second' },
    })]);
    expect(sendMessageByChannel).toHaveBeenCalledWith(channel, 'Hello', expect.any(Object), SITE_ID,
      undefined, CONV_ID, undefined, MSG_ID, 'audio', {message_type:undefined, media_url:undefined, mime_type:undefined});
    expect(getConversationChannel).toHaveBeenCalledTimes(1);
    expect(resolveAudioRouting).toHaveBeenCalledWith({ siteId: SITE_ID, conversationId: CONV_ID, channel, allowLegacyWhatsApp: true });
    expect((sendMessageByChannel as jest.Mock).mock.calls[0][2].channelDelivery).toBe(true);
  });

  it('rejects ambiguous routing before saving or dispatching audio', async () => {
    (resolveAudioRouting as jest.Mock).mockRejectedValueOnce(new AudioRoutingError());
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', response_format: 'audio' }),
    }));
    expect(response.status).toBe(409);
    for (const result of fromMock.mock.results) expect(result.value.insert).not.toHaveBeenCalled();
    expect(sendMessageByChannel).not.toHaveBeenCalled();
  });

  it('persists legacy WhatsApp selection and keeps the non-channel Twilio workflow', async () => {
    (resolveAudioRouting as jest.Mock).mockResolvedValueOnce({ kind: 'legacy-whatsapp', connectionId: 'legacy:whatsapp' });
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', response_format: 'audio' }),
    }));
    expect(response.status).toBe(200);
    const messages = fromMock.mock.results.find((_, i) => fromMock.mock.calls[i][0] === 'messages')!.value;
    expect(messages.insert).toHaveBeenCalledWith([expect.objectContaining({
      custom_data: expect.objectContaining({ connection_id: 'legacy:whatsapp' }),
    })]);
    expect((sendMessageByChannel as jest.Mock).mock.calls[0][2].channelDelivery).toBe(false);
  });

  it.each(['email', 'voice', 'web', 'instagram', undefined])('rejects audio on %s before any message write', async (channel) => {
    (getConversationChannel as jest.Mock).mockResolvedValue({ channel });
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', response_format: 'audio' }),
    }));
    expect(response.status).toBe(400);
    for (const result of fromMock.mock.results) {
      expect(result.value.insert).not.toHaveBeenCalled();
      expect(result.value.update).not.toHaveBeenCalled();
    }
    expect(sendMessageByChannel).not.toHaveBeenCalled();
  });

  it.each([null, 'video', '', 1])('rejects invalid request format %s', async (format) => {
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', response_format: format }),
    }));
    expect(response.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('accepts explicit text and retains it in metadata and dispatch', async () => {
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', response_format: 'text' }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.message.custom_data.response_format).toBe('text');
    expect((sendMessageByChannel as jest.Mock).mock.calls[0][8]).toBe('text');
  });

  it('rejects oversized explicit audio before saving', async () => {
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'a'.repeat(4001), response_format: 'audio' }),
    }));
    expect(response.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
    expect(sendMessageByChannel).not.toHaveBeenCalled();
  });

  it('does not allow caller channel hints to override the conversation channel', async () => {
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', response_format: 'audio', channel: 'whatsapp' }),
    }));
    expect(response.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
    expect(sendMessageByChannel).not.toHaveBeenCalled();
  });

  it.each(['whatsapp', 'email'])('validates saved audio on a retry with omitted selection (%s)', async (channel) => {
    const conversations = createChain({ data: { id: CONV_ID, site_id: SITE_ID }, error: null });
    const messages = createChain({ data: { id: MSG_ID, conversation_id: CONV_ID, content: 'Hello',
      custom_data: { status: 'failed', response_format: 'audio' } }, error: null });
    fromMock.mockImplementation((table: string) => table === 'messages' ? messages : conversations);
    (getConversationChannel as jest.Mock).mockResolvedValue({ channel });
    const response = await POST(new Request('http://localhost/api/agents/chat/intervention', {
      method: 'POST', headers: { Authorization: 'Bearer test-session' },
      body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', message_id: MSG_ID }),
    }));
    if (channel === 'email') {
      expect(response.status).toBe(400);
      expect(messages.update).not.toHaveBeenCalled();
      expect(sendMessageByChannel).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
      expect((sendMessageByChannel as jest.Mock).mock.calls[0][8]).toBe('audio');
      expect(messages.update).toHaveBeenCalledWith({ custom_data: {
        status: 'accepted', command_status: 'pending', dispatch_owner: 'chat_intervention', response_format: 'audio', connection_id: 'selected-second',
      } });
    }
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
    expect(body.data.message.custom_data).toMatchObject({ status: 'accepted', command_status: 'pending', dispatch_owner: 'chat_intervention' });
    expect(body.data.message.custom_data).not.toHaveProperty('sent_at');
    expect(body.data.channel_send.workflowId).toBe('wf-started');
    expect(sendMessageByChannel).toHaveBeenCalledTimes(1);
    expect(fromMock).toHaveBeenCalledWith('messages');
    const messagesChain = fromMock.mock.results.find((_, i) => fromMock.mock.calls[i][0] === 'messages')?.value;
    expect(messagesChain.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        custom_data: { command_status: 'pending', status: 'accepted', dispatch_owner: 'chat_intervention' },
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

  it.each([{ dispatch_owner: 'chat_intervention' }, { status: 'accepted' }, { custom_data: { status: 'accepted' } }])(
    'never delegates approval or dispatch ownership to caller-provided fields: %j', async extra => {
      const res = await POST(new Request('http://localhost/api/agents/chat/intervention', { method: 'POST',
        headers: { Authorization: 'Bearer test-session' }, body: JSON.stringify({ conversationId: CONV_ID, message: 'Hello', ...extra }) }));
      expect(res.status).toBe(400);
      expect(fromMock).not.toHaveBeenCalled(); expect(sendMessageByChannel).not.toHaveBeenCalled();
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
