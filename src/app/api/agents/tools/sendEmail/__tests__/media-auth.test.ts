jest.mock('../core', () => ({ sendEmailCore: jest.fn() }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
import { POST } from '../route';
import { sendEmailCore } from '../core';
import { canAccessSite } from '@/lib/security/site-access';
import { NextRequest } from 'next/server';

beforeEach(() => jest.clearAllMocks());
test('denies media requests before core can download or dispatch', async () => {
  jest.mocked(canAccessSite).mockResolvedValue(false);
  const response = await POST(new NextRequest('https://api.example.test/api/agents/tools/sendEmail', {
    method: 'POST', body: JSON.stringify({ site_id: 'foreign', email: 'recipient@example.test', subject: 'File', message: '',
      message_type: 'document', media_url: 'https://assets.example.test/file.pdf' }),
  }));
  expect(response.status).toBe(403);
  expect(sendEmailCore).not.toHaveBeenCalled();
});
test('authorized route retains canonical attachment fields', async () => {
  jest.mocked(canAccessSite).mockResolvedValue(true);
  jest.mocked(sendEmailCore).mockResolvedValue({ success: true, status: 'sent' });
  const body = { site_id: 'site', email: 'recipient@example.test', subject: 'File', message: '',
    message_type: 'document', media_url: 'https://assets.example.test/file.pdf', mime_type: 'application/pdf' };
  expect((await POST(new NextRequest('https://api.example.test/send', { method: 'POST', body: JSON.stringify(body) }))).status).toBe(201);
  expect(sendEmailCore).toHaveBeenCalledWith(body);
});