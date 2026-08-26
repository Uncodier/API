import { POST } from '@/app/api/agents/chat/intervention/route';
import { getConversationChannel, sendMessageByChannel } from '@/app/api/agents/chat/intervention/send-intervention-by-channel';

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
  return chain;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONV_ID = '22222222-2222-4222-8222-222222222222';
const MSG_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';

describe('POST /api/agents/chat/intervention', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    const conversations = createChain({ data: { id: CONV_ID }, error: null });
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
});
