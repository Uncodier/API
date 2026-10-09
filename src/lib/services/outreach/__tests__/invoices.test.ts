jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('../transport', () => ({ prepareOutreachDelivery: jest.fn() }));
jest.mock('@/lib/utils/redis-client', () => ({ getRedisClient: jest.fn() }));
jest.mock('../invoice-generation', () => ({ generateInvoiceReminder: jest.fn() }));
jest.mock('@/lib/services/lead-followup/helpers/LeadFollowUpAgentHelper', () => ({ findActiveSalesAgent: jest.fn() }));
import { createInvoiceReminders, invoiceRepository } from '../invoices';
import { createOutreachDelivery, type Snapshot, type OutreachRepository } from '../delivery';
import { invoiceCooldownDays, invoiceDueReason, invoiceMessageReason } from '../invoice-state';
import { getOutreachPolicy } from '../policy';
import { summarizeOutreachHistory } from '../history';
import { assertOutreachGeneration } from '../generation-guard';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const now = new Date('2026-10-06T16:00:00Z');
function snapshot(): Snapshot {
  return { sale: { id: 'sale', site_id: 'site', lead_id: 'lead', status: 'pending', amount_due: 100, currency: 'USD', due_date: '2026-10-06' },
    lead: { id: 'lead', site_id: 'site', status: 'converted', assignee_id: 'human', email: 'buyer@example.com', phone: '+15551234567' },
    reminder: { id: 'receipt', site_id: 'site', sale_id: 'sale', message_id: 'message', state: 'ready', reminder_key: 'key' },
    conversation: { id: 'conversation', site_id: 'site', lead_id: 'lead', channel: 'email' }, conversations: [],
    message: { id: 'message', conversation_id: 'conversation', role: 'assistant', content: 'Your invoice is due.', custom_data: {
      status: 'accepted', channel: 'email', outreach_activity: 'invoices_due', sale_id: 'sale', invoice_reminder_id: 'receipt',
      invoice_reminder_key: 'key', invoice_due_date: '2026-10-06', invoice_amount_due: 100, invoice_currency: 'USD' } },
    settings: { business_hours: [{ timezone: 'America/Mexico_City' }],
      channels: { connections: [{ id: 'email-account', type: 'email', status: 'connected', zavu_sender_id: 'sender' }] },
      activities: { invoices_due: { status: 'active', channel_accounts: { email: ['email-account'] } } } } };
}

test('invoice opt-in and interval are strict, default interval three days', () => {
  expect(getOutreachPolicy({}, 'invoices_due')).toBeNull();
  const s = snapshot().settings;
  expect(getOutreachPolicy(s, 'invoices_due')).toMatchObject({ repeat_interval_days: 3, cooldown_mode: 'progressive', weekdays: [1, 2, 3, 4, 5], daily_message_limit: 30 });
  for (const interval of [null, 0, 366, '3', 1.5]) {
    s.activities.invoices_due.repeat_interval_days = interval;
    expect(getOutreachPolicy(s, 'invoices_due')).toBeNull();
  }
});
test('invoice cadence starts with consecutive days and widens, without changing legacy fixed settings', () => {
  expect([1, 2, 3, 4, 5, 6].map(count => invoiceCooldownDays(count, 'progressive', 3))).toEqual([1, 1, 3, 7, 14, 14]);
  const state = snapshot();
  state.settings.activities.invoices_due.repeat_interval_days = 5;
  expect(getOutreachPolicy(state.settings, 'invoices_due')).toMatchObject({ cooldown_mode: 'fixed', repeat_interval_days: 5 });
  state.settings.activities.invoices_due.cooldown_mode = 'progressive';
  expect(getOutreachPolicy(state.settings, 'invoices_due')).toMatchObject({ cooldown_mode: 'progressive' });
  for (const value of ['unknown', null]) {
    state.settings.activities.invoices_due.cooldown_mode = value;
    expect(getOutreachPolicy(state.settings, 'invoices_due')).toBeNull();
  }
});
test('delivery waits for the per-invoice progressive stage, not the lead history', () => {
  const state = snapshot();
  state.site = { id: 'site' };
  state.lastSentAt = '2026-10-03T16:00:00Z';
  state.sentCount = 3;
  expect(invoiceMessageReason('site', state, new Date('2026-10-06T15:59:59Z'))).toBe('repeat_interval');
  expect(invoiceMessageReason('site', state, now)).toBeUndefined();
  state.sentCount = 4;
  expect(invoiceMessageReason('site', state, now)).toBe('repeat_interval');
});
test.each([
  ['paid', (s: any) => { s.sale.amount_due = 0; }, 'invoice_not_due'],
  ['completed', (s: any) => { s.sale.status = 'completed'; }, 'invoice_not_due'],
  ['cancelled', (s: any) => { s.sale.status = 'cancelled'; }, 'invoice_not_due'],
  ['missing date', (s: any) => { s.sale.due_date = null; }, 'invoice_not_due'],
  ['invalid date', (s: any) => { s.sale.due_date = '2026-02-30'; }, 'invoice_not_due'],
  ['future date', (s: any) => { s.sale.due_date = '2026-10-07'; }, 'invoice_not_due'],
  ['foreign sale', (s: any) => { s.sale.site_id = 'other'; }, 'sale_not_found'],
  ['foreign recipient', (s: any) => { s.lead.site_id = 'other'; }, 'unsupported_recipient'],
  ['buyer-only', (s: any) => { s.sale.lead_id = null; }, 'unsupported_recipient'],
  ['optout', (s: any) => { s.lead.metadata = { do_not_contact: true }; }, 'recipient_ineligible'],
  ['quarantined', (s: any) => { s.lead.metadata = { quarantined_cross_tenant: true }; }, 'recipient_ineligible'],
  ['unsubscribed', (s: any) => { s.lead.unsubscribed = true; }, 'recipient_ineligible'],
  ['disabled', (s: any) => { s.settings.activities.invoices_due.status = 'inactive'; }, 'activity_inactive'],
] as const)('invoice guard rejects %s', (_name, mutate, reason) => {
  const s = snapshot(); mutate(s);
  expect(invoiceDueReason('site', s.sale, s.lead, s.settings, now)).toBe(reason);
});
test('due dates use the tenant local calendar, not the UTC calendar', () => {
  const s = snapshot();
  expect(invoiceDueReason('site', s.sale, s.lead, s.settings, new Date('2026-10-06T02:00:00Z'))).toBe('invoice_not_due');
  expect(invoiceDueReason('site', s.sale, s.lead, s.settings, new Date('2026-10-06T12:00:00Z'))).toBe('before_start_time');
  expect(invoiceDueReason('site', s.sale, s.lead, s.settings, now)).toBeUndefined();
});
test('invoice reminders never inflate prospect unanswered count or grant lead generation exemption', async () => {
  expect(summarizeOutreachHistory([{ id: 'm', role: 'assistant', created_at: now.toISOString(), custom_data: {
    status: 'sent', outreach_activity: 'invoices_due' } }]).unanswered).toBe(0);
  await expect(assertOutreachGeneration(new Request('http://localhost'), 'site', 'lead', 'invoices_due'))
    .rejects.toMatchObject({ status: 400, message: 'Use the dueInvoices endpoint for invoice reminders' });
});

function deliveryFixture() {
  const state = snapshot();
  const repo: OutreachRepository = { load: jest.fn(async () => structuredClone(state)), history: jest.fn(async () => []),
    segmentBelongsToSite: jest.fn(async () => false), reservedCount: jest.fn(async () => 0),
    claim: jest.fn(async (_m, marker) => { state.message.custom_data.outreach_delivery = marker; return true; }),
    mark: jest.fn(async (_m, marker) => { state.message.custom_data.outreach_delivery = marker; }) };
  const ledger: any = { reserve: jest.fn(async () => ({ state: 'reserved', lease: { attemptId: 'attempt' } })), release: jest.fn(), sent: jest.fn() };
  const send = jest.fn(async () => ({ success: true, messageId: 'provider' }));
  const prepare = jest.fn(async () => ({ send }));
  const deliver = createOutreachDelivery({ repository: repo, ledger, prepare, now: () => now });
  return { state, repo, ledger, send, prepare, deliver };
}
test('converted assigned buyer can receive a real guarded reminder with no inbound, segment or unanswered filter', async () => {
  const f = deliveryFixture();
  f.repo.history = jest.fn(async () => Array.from({ length: 6 }, (_, n) => ({ id: `sent-${n}`, role: 'assistant', created_at: now.toISOString(), custom_data: { status: 'sent' } })));
  expect(await f.deliver('site', 'message')).toMatchObject({ success: true, messageId: 'provider' });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.repo.segmentBelongsToSite).not.toHaveBeenCalled();
});
test.each([
  ['payment', (s: any) => { s.sale.amount_due = 0; }, 'invoice_not_due'],
  ['partial payment', (s: any) => { s.sale.amount_due = 50; }, 'invoice_changed'],
  ['disabled', (s: any) => { s.settings.activities.invoices_due.status = 'inactive'; }, 'activity_inactive'],
  ['optout', (s: any) => { s.lead.unsubscribed = true; }, 'recipient_ineligible'],
  ['recipient change', (s: any) => { s.lead.email = 'other@example.com'; }, 'recipient_changed'],
  ['account removal', (s: any) => { s.settings.channels.connections = []; }, 'selected_account_changed'],
] as const)('payment/removal recheck after preparation blocks %s', async (_name, mutate, reason) => {
  const f = deliveryFixture(); f.prepare.mockImplementation(async () => { mutate(f.state); return { send: f.send }; });
  expect(await f.deliver('site', 'message')).toMatchObject({ reason });
  expect(f.ledger.reserve).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});
test('payment between Redis reservation and final provider closure is blocked', async () => {
  const f = deliveryFixture();
  f.ledger.reserve.mockImplementation(async () => { f.state.sale.status = 'completed'; return { state: 'reserved', lease: { attemptId: 'attempt' } }; });
  expect(await f.deliver('site', 'message')).toMatchObject({ reason: 'invoice_not_due' });
  expect(f.send).not.toHaveBeenCalled(); expect(f.ledger.release).toHaveBeenCalledTimes(1);
});
test('metadata without persisted sale receipt never enables invoice exemptions', async () => {
  const f = deliveryFixture(); f.state.reminder = null;
  expect(await f.deliver('site', 'message')).toMatchObject({ reason: 'invoice_reminder_not_authorized' });
  expect(f.send).not.toHaveBeenCalled();
});
test.each([null, {}, { state: 'uncertain' }])('malformed/uncertain invoice delivery marker never permits redis-reset resend', async marker => {
  const f = deliveryFixture(); f.state.message.custom_data.outreach_delivery = marker;
  expect(await f.deliver('site', 'message')).toMatchObject({ reason: 'delivery_uncertain' });
  expect(f.send).not.toHaveBeenCalled();
});
test('queued reminders obey archive and increased repeat interval before transport', async () => {
  const f = deliveryFixture(); f.state.site = { id: 'site', archived_at: now.toISOString() };
  expect(await f.deliver('site', 'message')).toMatchObject({ reason: 'site_inactive' });
  f.state.site = { id: 'site' }; f.state.lastSentAt = '2026-10-02T16:00:00Z';
  f.state.settings.activities.invoices_due.repeat_interval_days = 5;
  expect(await f.deliver('site', 'message')).toMatchObject({ reason: 'repeat_interval' });
  expect(f.send).not.toHaveBeenCalled();
});
test('invoice recipient still respects voice call optouts', async () => {
  const f = deliveryFixture(); f.state.message.custom_data.channel = 'voice'; f.state.conversation.channel = 'voice';
  f.state.settings.activities.invoices_due.channel_accounts = { voice: ['voice-account'] };
  f.state.settings.channels.connections = [{ id: 'voice-account', type: 'voice', status: 'connected', zavu_sender_id: 'voice' }];
  f.state.lead.do_not_call = true;
  expect(await f.deliver('site', 'message')).toMatchObject({ reason: 'voice_recipient_ineligible' });
  expect(f.send).not.toHaveBeenCalled();
});

test('concurrent hourly calls generate only once; ready retry reuses original message', async () => {
  const s = snapshot(); let claimed = false;
  const repo: typeof invoiceRepository = { load: jest.fn(async () => ({ sale: s.sale, site: { id: 'site', archived_at: null }, settings: s.settings, lead: s.lead, conversations: s.conversations || [] })), agent: jest.fn(async () => ({ agentId: 'agent', userId: 'user' })), cancel: jest.fn(), reservedCount: jest.fn(async () => 0),
    claim: jest.fn(async () => { if (claimed) return { reason: 'reminder_uncertain' }; claimed = true; return { claimed: true, reminder: s.reminder }; }),
    queue: jest.fn(async () => 'message') };
  const generate = jest.fn(async () => ({ title: 'Invoice due', message: 'Please pay', channel: 'email', command_id: 'command' }));
  const deliver = jest.fn(async () => ({ success: true, messageId: 'provider' }));
  const remind = createInvoiceReminders({ repository: repo, generate, deliver, now: () => now });
  const result = await Promise.all([remind('site', 'sale', 'key1'), remind('site', 'sale', 'key2')]);
  expect(generate).toHaveBeenCalledTimes(1); expect(deliver).toHaveBeenCalledTimes(1);
  expect(result).toContainEqual({ success: true, skipped: true, reason: 'reminder_uncertain' });
  (repo.claim as jest.Mock).mockResolvedValue({ reason: 'ready', reminder: { ...s.reminder, command_id: 'command' } });
  expect(await remind('site', 'sale', 'next-day')).toMatchObject({ success: true, message_id: 'message', command_id: 'command' });
  expect(generate).toHaveBeenCalledTimes(1);
  (repo.reservedCount as jest.Mock).mockResolvedValue(30);
  expect(await remind('site', 'sale', 'limit')).toMatchObject({ skipped: true, reason: 'daily_limit' });
  expect(generate).toHaveBeenCalledTimes(1);
  (repo.reservedCount as jest.Mock).mockRejectedValue(new Error('Database unavailable'));
  expect(await remind('site', 'sale', 'failure')).toEqual({ success: false, reason: 'invoice_reminder_unavailable' });
});
test('invoice loading always filters both sale and lead by tenant', async () => {
  const filters: any[] = []; const s = snapshot();
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => {
    const q: any = { select: () => q, eq: (k: string, v: string) => { filters.push([table, k, v]); return q; },
      order: () => q, range: async () => ({ data: [] }), maybeSingle: async () => ({ data: table === 'sales' ? s.sale : table === 'leads' ? s.lead : table === 'sites' ? { id: 'site' } : s.settings }) };
    return q;
  });
  await invoiceRepository.load('site', 'sale');
  expect(filters).toContainEqual(['sales', 'site_id', 'site']); expect(filters).toContainEqual(['leads', 'site_id', 'site']);
});