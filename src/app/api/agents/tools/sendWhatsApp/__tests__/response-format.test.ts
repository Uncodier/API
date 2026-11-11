import { NextRequest } from 'next/server';
import { POST } from '../route';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { canAccessSite } from '@/lib/security/site-access';

jest.mock('@/lib/services/whatsapp/WhatsAppSendService', () => ({ WhatsAppSendService: {
  isValidPhoneNumber: jest.fn(() => true), sendMessage: jest.fn(),
} }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async (url: string) => new URL(url)) }));
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

it.each(['image', 'video', 'audio', 'document'])('forwards existing %s files without requiring text', async message_type => {
  const media_url = 'https://media.example.test/existing-file';
  expect((await POST(request({ message: '', message_type, media_url }))).status).toBe(201);
  expect(WhatsAppSendService.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ message: '', message_type, media_url }));
});
it('forwards legacy media_urls instead of dropping attachments', async () => {
  const media_urls = ['https://media.example.test/photo.png'];
  expect((await POST(request({ media_urls }))).status).toBe(201);
  expect(WhatsAppSendService.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ media_urls }));
});
it('checks site access for attachments even without a response format', async () => {
  jest.mocked(canAccessSite).mockResolvedValue(false);
  expect((await POST(request({ media_urls: ['https://media.example.test/photo.png'] }))).status).toBe(403);
  expect(WhatsAppSendService.sendMessage).not.toHaveBeenCalled();
});
it.each([{ message_type: 'video' }, { media_urls: ['http://media.example.test/file'] },
  { response_format: 'audio', message_type: 'image', media_url: 'https://media.example.test/file' }])('rejects invalid media before sending %j', async extra => {
  expect((await POST(request(extra))).status).toBe(400);
  expect(WhatsAppSendService.sendMessage).not.toHaveBeenCalled();
});