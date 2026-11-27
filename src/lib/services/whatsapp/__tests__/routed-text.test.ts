import { getSiteLicensedResources } from '@/lib/billing/licensed-resources';
import { assertAutomationSendAllowed } from '../../channels/automation-send-guard';
import { attemptRoutedText } from '../routed-text-provider';
import { loadRoutedText, reconcileRoutedLeadPhone, writeRoutedText, type RoutedContext } from '../routed-text-store';
import { sendRoutedText } from '../routed-text';
import { RoutedTextRecipientError } from '../routed-text-identity';

jest.mock('@/lib/billing/licensed-resources', () => ({ getSiteLicensedResources: jest.fn(),
  isLicensedChannelConnection: (ch: string, row: any) => row.type === ch && row.status === 'connected' && !row.license_suspended }));
jest.mock('../../channels/automation-send-guard', () => ({ assertAutomationSendAllowed: jest.fn(), AutomationSendSuppressed: class extends Error {} }));
jest.mock('../routed-text-store', () => ({ loadRoutedText: jest.fn(), reconcileRoutedLeadPhone: jest.fn(), writeRoutedText: jest.fn() }));
jest.mock('../routed-text-provider', () => ({ attemptRoutedText: jest.fn() }));

const id = { site_id: 'site', conversation_id: 'chat', message_id: 'outbound' };
const twilio = { status: 'active', enabled: true, account_sid: 'account', from_number: '+15555550110' };
const zavu = (id: string) => ({ type: 'whatsapp', id, status: 'connected', license_suspended: false, zavu_sender_id: `sender-${id}` });
let ctx: RoutedContext;
const attempt = jest.mocked(attemptRoutedText);
const snap = <T>(v: T): T => JSON.parse(JSON.stringify(v));

beforeEach(() => {
  jest.resetAllMocks();
  ctx = { role: 'team_member', content: 'Your appointment is tomorrow.', text: 'Your appointment is tomorrow.',
    recipient: '+15555550100', metadata: { status: 'sending' }, conversation: {}, inbound: [] };
  jest.mocked(loadRoutedText).mockImplementation(async () => snap(ctx));
  jest.mocked(getSiteLicensedResources).mockResolvedValue({ effective_plan: 'foundry', social_media: [],
    channels: { connections: [zavu('A'), zavu('B')], whatsapp: twilio } });
  jest.mocked(writeRoutedText).mockImplementation(async (_, expected, previous, next) => {
    if (expected.content !== ctx.content || JSON.stringify(previous) !== JSON.stringify(ctx.metadata)) throw new Error('CAS lost');
    ctx.metadata = snap(next);
  });
});

it('unbound refusal tries the next eligible connection once, including a different provider; replay never sends', async () => {
  attempt.mockResolvedValueOnce({ kind: 'unavailable', reason: 'sender unavailable' })
    .mockResolvedValueOnce({ kind: 'unavailable', reason: 'sender unavailable' })
    .mockImplementationOnce(async input => { await input.verifyBinding(); return { kind: 'accepted', providerMessageId: 'receipt' }; });
  for (let i = 0; i < 2; i++) expect(await sendRoutedText(id)).toMatchObject({ success: true, status: 'accepted',
    connection_id: 'legacy:whatsapp', provider: 'twilio', provider_message_id: 'receipt' });
  expect(attempt.mock.calls.map(([a]) => a.route.connectionId)).toEqual(['A', 'B', 'legacy:whatsapp']);
  expect(ctx.metadata.whatsapp_text_delivery.refused.map((r: any) => r.connection_id)).toEqual(['A', 'B']);
});

it('Twilio 63007 on a default (not pinned) route can move to Zavu and poll only its own template', async () => {
  ctx.conversation.provider = 'twilio';
  attempt.mockResolvedValueOnce({ kind: 'unavailable', reason: 'Twilio 63007' })
    .mockResolvedValueOnce({ kind: 'pending', template: { id: 'z-template' } })
    .mockResolvedValueOnce({ kind: 'accepted', providerMessageId: 'z-accepted' });
  expect(await sendRoutedText(id)).toMatchObject({ status: 'template_pending', connection_id: 'A', template_id: 'z-template' });
  expect(ctx.metadata.status).toBe('queued');
  expect(await sendRoutedText(id)).toMatchObject({ status: 'accepted', connection_id: 'A' });
  expect(attempt.mock.calls.map(([a]) => [a.route.connectionId, a.template?.id, a.recipient])).toEqual([
    ['legacy:whatsapp', undefined, ctx.recipient], ['A', undefined, ctx.recipient], ['A', 'z-template', ctx.recipient]]);
});

it.each(['unknown', 'failed'] as const)('does not fail over for %s, even on replay', async kind => {
  attempt.mockResolvedValueOnce({ kind, reason: 'Not a sender configuration failure' });
  for (let i = 0; i < 2; i++) expect(await sendRoutedText(id)).toMatchObject({ success: false,
    status: kind === 'unknown' ? 'needs_reconciliation' : 'failed' });
  expect(attempt).toHaveBeenCalledTimes(1);
});

it('does not replace a saved exact sender or spin when the pool is exhausted', async () => {
  ctx.metadata.connection_id = 'B';
  attempt.mockResolvedValue({ kind: 'unavailable', reason: 'sender not available' });
  expect(await sendRoutedText(id)).toMatchObject({ status: 'failed' });
  expect(attempt.mock.calls.map(([a]) => a.route.connectionId)).toEqual(['B']);
});

it('does not disclose or dispatch to another recipient after a pending template is saved', async () => {
  attempt.mockResolvedValueOnce({ kind: 'pending', template: { id: 'pending' } });
  await sendRoutedText(id);
  ctx.recipient = '+15555550101';
  await expect(sendRoutedText(id)).rejects.toThrow('reconciliation');
  expect(attempt).toHaveBeenCalledTimes(1);
});

it('claims before a provider call; a concurrent request cannot dispatch', async () => {
  let concurrent: string | undefined;
  attempt.mockImplementationOnce(async input => { await input.verifyBinding(); concurrent = (await sendRoutedText(id)).status;
    return { kind: 'accepted', providerMessageId: 'receipt' }; });
  expect(await sendRoutedText(id)).toMatchObject({ status: 'accepted' });
  expect(concurrent).toBe('needs_reconciliation');
  expect(attempt).toHaveBeenCalledTimes(1);
});

it.each(['provider_message_id', 'twilio_message_id', 'exact_delivery_receipt', 'audio_delivery', 'pinned_text_delivery'])('never takes over prior %s', async key => {
  ctx.metadata[key] = 'prior';
  await expect(sendRoutedText(id)).rejects.toThrow('reconciliation');
  expect(attempt).not.toHaveBeenCalled();
});

it('does not treat an inventory read failure as a reason to dispatch', async () => {
  jest.mocked(getSiteLicensedResources).mockRejectedValue(new Error('read outage'));
  await expect(sendRoutedText(id)).rejects.toThrow('read outage');
  expect(attempt).not.toHaveBeenCalled();
  expect(writeRoutedText).not.toHaveBeenCalled();
});

it('continues the same send after repairing a verified lead phone', async () => {
  ctx.leadPhoneRepair = { leadId: 'lead', previous: null, updatedAt: 'version', voiceConsent: 'unknown' };
  jest.mocked(reconcileRoutedLeadPhone).mockImplementationOnce(async () => { delete ctx.leadPhoneRepair; });
  attempt.mockImplementationOnce(async input => {
    expect(reconcileRoutedLeadPhone).toHaveBeenCalledWith(id, expect.objectContaining({ recipient: input.recipient }));
    await input.verifyBinding();
    return { kind: 'accepted', providerMessageId: 'receipt' };
  });
  expect(await sendRoutedText(id)).toMatchObject({ status: 'accepted' });
  expect(attempt).toHaveBeenCalledTimes(1);
});

it('does not dispatch if the phone repair loses its compare-and-set', async () => {
  ctx.leadPhoneRepair = { leadId: 'lead', previous: null, updatedAt: 'version', voiceConsent: 'unknown' };
  jest.mocked(reconcileRoutedLeadPhone).mockRejectedValueOnce(new Error('WhatsApp lead phone changed during verification'));
  await expect(sendRoutedText(id)).rejects.toThrow('changed during verification');
  expect(attempt).not.toHaveBeenCalled();
  expect(writeRoutedText).not.toHaveBeenCalled();
});

it.each([
  { status: 'sending' },
  { status: 'accepted', command_status: 'pending', dispatch_owner: 'chat_intervention' },
])('rejects an unverified recipient before any provider attempt, even with manual approval: %j', async initial => {
  ctx.metadata = initial;
  const error = new RoutedTextRecipientError();
  error.snapshot = { role: ctx.role, content: ctx.content, metadata: snap(ctx.metadata) };
  jest.mocked(loadRoutedText).mockRejectedValueOnce(error);
  expect(await sendRoutedText(id)).toMatchObject({ success: false, status: 'failed', reason: error.message });
  expect(ctx.metadata).toMatchObject({ status: 'failed', command_status: 'failed', error_code: 'WHATSAPP_RECIPIENT_UNVERIFIED' });
  expect(ctx.metadata.whatsapp_text_delivery).toBeUndefined(); expect(attempt).not.toHaveBeenCalled();
});

it('an unverified recipient on an existing receipt or unscoped row never overwrites provider state', async () => {
  const error = new RoutedTextRecipientError();
  jest.mocked(loadRoutedText).mockRejectedValue(error);
  await expect(sendRoutedText(id)).rejects.toBe(error);
  error.snapshot = { role: ctx.role, content: ctx.content, metadata: { ...ctx.metadata, whatsapp_text_delivery: { state: 'attempting' } } };
  await expect(sendRoutedText(id)).rejects.toBe(error);
  expect(writeRoutedText).not.toHaveBeenCalled(); expect(attempt).not.toHaveBeenCalled();
});

it('performs one final check on the saved template and persists reconciliation if still pending', async () => {
  attempt.mockResolvedValue({ kind: 'pending', template: { id: 'waiting' } });
  await sendRoutedText(id);
  ctx.metadata.whatsapp_text_delivery.started_at -= 25 * 3600_000;
  expect(await sendRoutedText(id)).toMatchObject({ status: 'needs_reconciliation' });
  expect(ctx.metadata.status).toBe('needs_reconciliation');
  expect(await sendRoutedText(id)).toMatchObject({ status: 'needs_reconciliation' });
  expect(attempt).toHaveBeenCalledTimes(2);
  expect(attempt.mock.calls[1][0]).toMatchObject({ route: { connectionId: 'A' }, template: { id: 'waiting' } });
});

it.each(['accepted', 'failed', 'unavailable'] as const)('keeps the final %s outcome rather than dropping an approval/rejection at the deadline', async kind => {
  attempt.mockResolvedValueOnce({ kind: 'pending', template: { id: 'saved-template' } }).mockResolvedValueOnce(kind === 'accepted'
    ? { kind, providerMessageId: 'late-approval' } : { kind, reason: 'refusal' });
  await sendRoutedText(id);
  ctx.metadata.whatsapp_text_delivery.started_at -= 24.2 * 3600_000;
  const expected = kind === 'accepted' ? 'accepted' : 'failed';
  expect(await sendRoutedText(id)).toMatchObject({ status: expected });
  expect(await sendRoutedText(id)).toMatchObject({ status: expected });
  expect(attempt.mock.calls.map(([input]) => [input.route.connectionId, input.template?.id])).toEqual([
    ['A', undefined], ['A', 'saved-template']]);
});

it('never uses another provider after a negative delivery event for an accepted message', async () => {
  attempt.mockResolvedValueOnce({ kind: 'accepted', providerMessageId: 'accepted-by-zavu' });
  await sendRoutedText(id);
  ctx.metadata.status = 'failed';
  expect(await sendRoutedText(id)).toMatchObject({ status: 'failed', provider_message_id: 'accepted-by-zavu' });
  expect(attempt).toHaveBeenCalledTimes(1);
});

it('stops when there are no configured senders (no environment/global fallback)', async () => {
  jest.mocked(getSiteLicensedResources).mockResolvedValue({ effective_plan: 'foundry', social_media: [], channels: { connections: [] } });
  expect(await sendRoutedText(id)).toMatchObject({ status: 'failed', success: false });
  expect(attempt).not.toHaveBeenCalled();
});

it('rechecks snooze and connection immediately before sender effects', async () => {
  attempt.mockImplementationOnce(async input => {
    jest.mocked(getSiteLicensedResources).mockResolvedValue({ effective_plan: 'foundry', social_media: [],
      channels: { connections: [zavu('B')] } });
    await input.verifyBinding();
    throw new Error('Must not dispatch');
  });
  expect(await sendRoutedText(id)).toMatchObject({ status: 'needs_reconciliation' });
  expect(assertAutomationSendAllowed).toHaveBeenCalledWith({ ...id, message: ctx.content });
  expect(attempt).toHaveBeenCalledTimes(1);
});