import { createHmac, randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockFrom = jest.fn();
const mockGetCall = jest.fn();
let mockSecret: string;
jest.mock('@/lib/database/supabase-server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
  supabaseAdmin: { schema: () => ({ from: mockFrom }) },
}));
jest.mock('@/lib/utils/token-decryption', () => ({ decryptToken: () => mockSecret }));
jest.mock('@/lib/services/zavu/voice-call-client', () => ({ getVoiceCall: mockGetCall }));
import { POST } from '../route';

const SITE = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const DELIVERY = '44444444-4444-4444-8444-444444444444';
const PHONE = '+14155550100';

describe('signed voice context retrieval without provider contact metadata', () => {
  let reads: Array<{ table: string; filters: Record<string, unknown> }>;
  let contextSite: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSecret = randomBytes(32).toString('hex');
    contextSite = SITE;
    reads = [];
    mockGetCall.mockResolvedValue({ id: 'active-call', senderId: 'sender', direction: 'outbound', to: PHONE, status: 'in_progress' });
    mockFrom.mockImplementation((table: string) => {
      const read = { table, filters: {} as Record<string, unknown> };
      reads.push(read);
      const result = () => ({ data:
        table === 'agents' ? { configuration: { zavu: { tool_webhook_secret: randomBytes(16).toString('hex') } } }
          : table === 'voice_call_deliveries' ? [{ id: DELIVERY, message_id: MESSAGE, conversation_id: CONVERSATION, zavu_call_id: 'active-call', zavu_sender_id: 'sender' }]
            : table === 'conversations' ? { id: CONVERSATION }
              : table === 'messages' && read.filters['conversations.site_id'] === contextSite ? { id: MESSAGE, custom_data: {
                tool_execution_context: { version: 1, site_id: SITE, intent: 'Confirm Monday appointment at five', source: { tool: 'publish' } },
                voice_follow_up_context: 'Customer asked for Monday; previous attempt did not create a booking.',
              } } : null,
        error: null,
      });
      const q: any = {
        select: () => q, order: () => q, limit: () => q, in: () => q, is: () => q,
        eq: (key: string, value: unknown) => { read.filters[key] = value; return q; },
        maybeSingle: async () => result(),
        then: (resolve: any) => Promise.resolve(result()).then(resolve),
      };
      return q;
    });
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  function request(signed = true) {
    const body = JSON.stringify({ tool: 'get_call_context', arguments: {}, context: { contactPhone: PHONE, messageId: 'ignore-this-provider-id' } });
    const url = new URL('https://api.example.invalid/api/integrations/zavu/voice-tools');
    url.searchParams.set('siteId', SITE);
    return new NextRequest(url, { method: 'POST', body, headers: signed
      ? { 'x-zavu-signature': createHmac('sha256', mockSecret).update(body).digest('hex') } : {} });
  }

  it('returns the persisted publish intent and real outbound direction through the real executor', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ direction: 'outbound', objective: 'Confirm Monday appointment at five', source: { tool: 'publish' } });
    expect(reads.find(read => read.table === 'voice_call_deliveries')?.filters).toMatchObject({ site_id: SITE, recipient_phone: PHONE });
    expect(reads.find(read => read.table === 'messages')?.filters).toEqual({ id: MESSAGE, conversation_id: CONVERSATION, 'conversations.site_id': SITE });
  });

  it('does not load context for unsigned requests', async () => {
    expect((await POST(request(false))).status).toBe(401);
    expect(reads.some(read => read.table === 'messages')).toBe(false);
    expect(mockGetCall).not.toHaveBeenCalled();
  });

  it('fails closed for foreign messages and never returns their contents', async () => {
    contextSite = CONVERSATION;
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).not.toContain('Monday');
  });
});