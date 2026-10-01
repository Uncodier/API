import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { deliverHarnessSupportTicket } from '@/lib/services/harness-diagnostics/support';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/sendgrid-service', () => ({ sendGridService: { sendEmail: jest.fn() } }));
const context = { siteId: 'site', instanceId: 'instance', runtime: 'assistant', toolNames: [] };
const ticket = { id: 'ticket', requirement_id: 'req', reason: '<script>unsafe</script>', payload: { requested_action: 'Fix dispatch' } };
function chain(data: any, error: any = null) {
  const q: any = { then: (fn: any) => Promise.resolve({ data, error }).then(fn) };
  for (const key of ['update', 'eq', 'in', 'select', 'maybeSingle']) q[key] = jest.fn(() => q);
  return q;
}
const env = { ...process.env };
beforeEach(() => { jest.clearAllMocks(); delete process.env.HARNESS_SUPPORT_EMAIL; delete process.env.UNCODIE_SUPPORT_EMAIL; delete process.env.SUPPORT_EMAIL; process.env.SENDGRID_API_KEY = 'test-configured'; });
afterAll(() => { process.env = env; });
it('never invents a recipient or claims delivery when support is unconfigured', async () => {
  expect(await deliverHarnessSupportTicket(ticket, context)).toMatchObject({ state: 'unconfigured', email_sent: false });
  expect(sendGridService.sendEmail).not.toHaveBeenCalled();
});
it('claims delivery once, escapes agent content and uses only configured support', async () => {
  process.env.HARNESS_SUPPORT_EMAIL = 'support@example.com';
  (supabaseAdmin.from as jest.Mock).mockReturnValueOnce(chain({ id: 'ticket' })).mockReturnValueOnce(chain(null));
  (sendGridService.sendEmail as jest.Mock).mockResolvedValue({ success: true });
  expect(await deliverHarnessSupportTicket(ticket, context)).toMatchObject({ state: 'sent', email_sent: true });
  expect(sendGridService.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'support@example.com', html: expect.not.stringContaining('<script>') }));
});
it('does not resend a delivery whose outcome is uncertain', async () => {
  process.env.HARNESS_SUPPORT_EMAIL = 'support@example.com';
  (supabaseAdmin.from as jest.Mock).mockReturnValueOnce(chain(null)).mockReturnValueOnce(chain({ email_state: 'sending' }));
  expect(await deliverHarnessSupportTicket(ticket, context)).toMatchObject({ state: 'sending', email_sent: false });
  expect(sendGridService.sendEmail).not.toHaveBeenCalled();
});

it('does not consume delivery when configuration is missing and can send the same ticket after configuration', async () => {
  process.env.HARNESS_SUPPORT_EMAIL = 'support@example.com';
  delete process.env.SENDGRID_API_KEY;
  expect(await deliverHarnessSupportTicket(ticket, context)).toMatchObject({ state: 'unconfigured', email_sent: false });
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  process.env.SENDGRID_API_KEY = 'test-configured';
  (supabaseAdmin.from as jest.Mock).mockReturnValueOnce(chain({ id: 'ticket' })).mockReturnValueOnce(chain(null));
  (sendGridService.sendEmail as jest.Mock).mockResolvedValue({ success: true });
  expect(await deliverHarnessSupportTicket(ticket, context)).toMatchObject({ state: 'sent', email_sent: true });
});