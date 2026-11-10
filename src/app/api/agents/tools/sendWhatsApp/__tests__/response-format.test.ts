import { NextRequest } from 'next/server';
import { POST } from '../route';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { canAccessSite } from '@/lib/security/site-access';

jest.mock('@/lib/services/whatsapp/WhatsAppSendService', () => ({ WhatsAppSendService: {
  isValidPhoneNumber: jest.fn(() => true), sendMessage: jest.fn(),
} }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: () => {
  const q: any = { select: () => q, eq: () => q,
    single: async () => ({ data: { channels: { whatsapp: { enabled: true } } } }),
    limit: async () => ({ data: [] }),
  };
  return q;
} } }));

const body = { site_id: 'site', phone_number: '+15555550100', message: 'Hello',
  conversation_id: 'conversation', message_id: 'saved' };
const request = (extra: Record<string, unknown>) => new NextRequest('https://api.example.test/send', {
  method: 'POST', body: JSON.stringify({ ...body, ...extra }),
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(canAccessSite).mockResolvedValue(true);
  jest.mocked(WhatsAppSendService.sendMessage).mockResolvedValue({ success: true, message_id: 'provider', status: 'sent' });
});

it.each(['text', 'audio'])('forwards explicit %s and the saved message identity', async response_format => {
  expect((await POST(request({ response_format }))).status).toBe(201);
  expect(WhatsAppSendService.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ ...body, response_format }));
});
it('rejects invalid formats before sending', async () => {
  expect((await POST(request({ response_format: 'video' }))).status).toBe(400);
  expect(WhatsAppSendService.sendMessage).not.toHaveBeenCalled();
});
it('checks authorization for the explicit format path', async () => {
  jest.mocked(canAccessSite).mockResolvedValue(false);
  expect((await POST(request({ response_format: 'audio' }))).status).toBe(403);
  expect(WhatsAppSendService.sendMessage).not.toHaveBeenCalled();
});
it('returns a terminal audio error instead of a successful template response', async () => {
  jest.mocked(WhatsAppSendService.sendMessage).mockResolvedValue({ success: false,
    error: { code: 'AUDIO_DELIVERY_FAILED', message: 'Window closed' } });
  expect((await POST(request({ response_format: 'audio' }))).status).toBe(422);
});