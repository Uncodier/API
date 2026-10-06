jest.mock('@/lib/agentbase', () => ({ CommandFactory: { createCommand: jest.fn(p => p) } }));
jest.mock('@/lib/services/lead-followup/helpers/LeadFollowUpCommandHelper', () => ({ commandService: { submitCommand: jest.fn(async () => 'internal') }, waitForCommandCompletion: jest.fn() }));
import { createInvoiceReminderCommand, generateInvoiceReminder } from '../invoice-generation';
import { waitForCommandCompletion } from '@/lib/services/lead-followup/helpers/LeadFollowUpCommandHelper';
const input = { siteId: 'site', sale: { id: 'sale', title: 'Invoice', amount_due: 20, currency: 'USD', due_date: '2026-10-06' },
  lead: { name: 'Customer', language: 'en' }, channels: ['email'], agent: { agentId: 'agent', userId: 'owner' } };
test('real invoice generation submits dedicated target with no qualification/delivery tools', async () => {
  const command: any = createInvoiceReminderCommand(input);
  expect(command).toMatchObject({ task: 'invoice payment reminder', site_id: 'site', userId: 'owner', tools: [] });
  expect(command.description).toContain('NOT sales prospecting');
  expect(command.targets).toHaveLength(1);
  expect(command.targets[0]).toHaveProperty('invoice_reminder_content');
  (waitForCommandCompletion as jest.Mock).mockResolvedValue({ completed: true, dbUuid: 'db-command', command: {
    status: 'completed', results: [{ invoice_reminder_content: { title: 'Invoice due', message: 'Please pay your invoice.', channel: 'email' } }] } });
  expect(await generateInvoiceReminder(input)).toMatchObject({ command_id: 'db-command', channel: 'email', message: 'Please pay your invoice.' });
});
test.each([
  { title: '', message: 'Pay', channel: 'email' },
  { title: 'Pay', message: '', channel: 'email' },
  { title: 'Pay', message: 'Pay', channel: 'whatsapp' },
])('generation fails closed on missing content or unselected channels', async content => {
  (waitForCommandCompletion as jest.Mock).mockResolvedValue({ completed: true, command: { status: 'completed', results: [{ invoice_reminder_content: content }] } });
  await expect(generateInvoiceReminder(input)).rejects.toThrow();
});
test('generation timeout never fabricates fallback reminder', async () => {
  (waitForCommandCompletion as jest.Mock).mockResolvedValue({ completed: false, command: { status: 'pending' } });
  await expect(generateInvoiceReminder(input)).rejects.toThrow('generation unconfirmed');
});