jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('../invoices', () => ({ createInvoiceReminders: () => jest.fn(async () => ({ success: true, message_id: 'message', command_id: 'command' })) }));
import { POST } from '@/app/api/agents/sales/dueInvoices/route';
import { canAccessSite } from '@/lib/security/site-access';
const body = { site_id: '00000000-0000-4000-8000-000000000001', sale_id: '00000000-0000-4000-8000-000000000002', outreach_activity: 'invoices_due', reminder_key: 'invoice-due:uuid:2026-10-06' };
const request = (data: any) => new Request('http://localhost/api/agents/sales/dueInvoices', { method: 'POST', body: JSON.stringify(data) });
test('unauthorized tenant request never invokes reminder action', async () => {
  (canAccessSite as jest.Mock).mockResolvedValue(false);
  const response = await POST(request(body));
  expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ success: false, reason: 'site_access_denied' });
});
test.each([{ recipient: 'stranger@example.com' }, { lead_id: 'lead' }, { channel: 'email' }, { outreach_activity: 'leads_follow_up' }, { reminder_key: '' }])('rejects untrusted overrides / wrong provenance', async overrides => {
  expect((await POST(request({ ...body, ...overrides }))).status).toBe(400);
});
test('uses agent endpoint envelope with persistent message and command identities', async () => {
  (canAccessSite as jest.Mock).mockResolvedValue(true);
  expect(await (await POST(request(body))).json()).toEqual({ success: true, data: { success: true, message_id: 'message', command_id: 'command' } });
});