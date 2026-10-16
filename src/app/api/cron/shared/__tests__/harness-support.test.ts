import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { deliverHarnessSupportTicket } from '@/lib/services/harness-diagnostics/support';
import { randomBytes } from 'node:crypto';
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
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { NODE_ENV: 'test', SENDGRID_API_KEY: randomBytes(32).toString('hex') };
});
afterEach(() => { process.env = { ...env }; });
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
  process.env.SENDGRID_API_KEY = randomBytes(32).toString('hex');
  (supabaseAdmin.from as jest.Mock).mockReturnValueOnce(chain({ id: 'ticket' })).mockReturnValueOnce(chain(null));
  (sendGridService.sendEmail as jest.Mock).mockResolvedValue({ success: true });
  expect(await deliverHarnessSupportTicket(ticket, context)).toMatchObject({ state: 'sent', email_sent: true });
});

function configureZavu() {
  process.env.TRANSACTIONAL_EMAIL_PROVIDER = 'zavu';
  process.env.ZAVUDEV_API_KEY = randomBytes(32).toString('hex');
  process.env.TRANSACTIONAL_EMAIL_FROM_EMAIL = 'hi@example.invalid';
  process.env.TRANSACTIONAL_EMAIL_ZAVU_SITE_ID = 'internal-site';
  process.env.TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID = 'internal-connection';
  process.env.HARNESS_SUPPORT_EMAIL = 'support@example.invalid';
  delete process.env.SENDGRID_API_KEY;
}

it('delivers with Zavu-only configuration, without requiring SendGrid', async () => {
  configureZavu();
  (supabaseAdmin.from as jest.Mock).mockReturnValueOnce(chain({ id: ticket.id })).mockReturnValueOnce(chain(null));
  (sendGridService.sendEmail as jest.Mock).mockResolvedValue({ success: true });
  expect(await deliverHarnessSupportTicket(ticket, context)).toMatchObject({ state: 'sent', email_sent: true });
  expect(sendGridService.sendEmail).toHaveBeenCalledTimes(1);
  expect(sendGridService.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
    to: 'support@example.invalid', idempotencyKey: 'harness-support-site-ticket',
  }));
});

it.each(['ZAVUDEV_API_KEY', 'TRANSACTIONAL_EMAIL_FROM_EMAIL', 'TRANSACTIONAL_EMAIL_ZAVU_SITE_ID', 'TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID'])(
  'does not consume a claim when Zavu config is missing %s', async key => {
    configureZavu(); delete process.env[key];
    const result = await deliverHarnessSupportTicket(ticket, context);
    expect(result).toMatchObject({ state: 'unconfigured', email_sent: false });
    expect('message' in result ? result.message : undefined).toContain(key);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(sendGridService.sendEmail).not.toHaveBeenCalled();
  },
);

it('fails closed for an invalid provider without a claim or fallback', async () => {
  configureZavu(); process.env.TRANSACTIONAL_EMAIL_PROVIDER = 'typo';
  expect(await deliverHarnessSupportTicket(ticket, context)).toMatchObject({ state: 'unconfigured', email_sent: false });
  expect(supabaseAdmin.from).not.toHaveBeenCalled(); expect(sendGridService.sendEmail).not.toHaveBeenCalled();
});

it('preserves the one-claim rule for uncertain Zavu outcomes', async () => {
  configureZavu();
  (supabaseAdmin.from as jest.Mock).mockReturnValueOnce(chain(null)).mockReturnValueOnce(chain({ email_state: 'sending' }));
  expect(await deliverHarnessSupportTicket(ticket, context)).toMatchObject({ state: 'sending', email_sent: false });
  expect(sendGridService.sendEmail).not.toHaveBeenCalled();
});

it('refuses an invalid Zavu from address before consuming a ticket claim', async () => {
  configureZavu(); process.env.TRANSACTIONAL_EMAIL_FROM_EMAIL = 'invalid';
  expect(await deliverHarnessSupportTicket(ticket, context)).toMatchObject({ state: 'unconfigured', email_sent: false });
  expect(supabaseAdmin.from).not.toHaveBeenCalled(); expect(sendGridService.sendEmail).not.toHaveBeenCalled();
});