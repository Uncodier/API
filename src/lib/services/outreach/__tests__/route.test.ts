jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('../delivery', () => ({ createOutreachDelivery: () => jest.fn(async () => ({ success: false, deferred: true, reason: 'daily_limit' })) }));
import { POST } from '@/app/api/agents/tools/sendOutreachMessage/route';
import { canAccessSite } from '@/lib/security/site-access';
const body = { site_id: '00000000-0000-4000-8000-000000000001', message_id: '00000000-0000-4000-8000-000000000002' };
const request = (data: any) => new Request('http://localhost/api/agents/tools/sendOutreachMessage', { method: 'POST', body: JSON.stringify(data) });
test('central tool explicitly verifies tenant access', async () => {
  (canAccessSite as jest.Mock).mockResolvedValue(false);
  const response = await POST(request(body));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ success: false, reason: 'site_access_denied' });
});
test('strict body denies caller-provided recipient/provider overrides', async () => {
  expect((await POST(request({ ...body, recipient: 'other@example.com' }))).status).toBe(400);
});
test('daily deferrals use successful HTTP response with raw deferred contract', async () => {
  (canAccessSite as jest.Mock).mockResolvedValue(true);
  const response = await POST(request(body));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: false, deferred: true, reason: 'daily_limit' });
});