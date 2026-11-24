import { supabaseAdmin } from '@/lib/database/supabase-client';
import { readRoutedTextOutcome, stopRoutedTextPoll } from '../routed-text-recovery';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
const ids = { site_id: 'site', conversation_id: 'chat', message_id: 'saved' };
const binding = { provider: 'twilio' as const, connection_id: 'legacy:whatsapp', template_id: 'template',
  attempt_id: '00000000-0000-4000-8000-000000000001' };
const field = 'whatsapp_text_delivery';
let metadata: Record<string, any>;
let writes: number;
let loseCas: boolean;
beforeEach(() => {
  writes = 0; loseCas = false;
  metadata = { status: 'queued', tracking: 'untouched', [field]: { key: 'saved', state: 'pending',
    route: { provider: binding.provider, connectionId: binding.connection_id }, template: { id: binding.template_id }, attempt_id: binding.attempt_id } };
  jest.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    if (table !== 'messages') throw new Error(`unexpected table ${table}`);
    const filters: Record<string, unknown> = {}; let update: { custom_data: Record<string, unknown> } | undefined;
    const q = { select: () => q, in: (k: string, v: unknown) => { filters[k] = v; return q; },
      eq: (k: string, v: unknown) => { filters[k] = v; return q; }, update: (v: typeof update) => { update = v; return q; },
      maybeSingle: async () => {
        expect(filters).toMatchObject({ id: ids.message_id, conversation_id: ids.conversation_id });
        if (update) {
          if (loseCas || filters.custom_data !== JSON.stringify(metadata)) return { data: null };
          writes++; metadata = update.custom_data; return { data: { id: ids.message_id } };
        }
        if (filters['conversations.site_id'] !== ids.site_id) return { data: null };
        expect(filters.role).toEqual(['assistant', 'team_member']);
        return { data: { role: 'assistant', conversations: { channel: 'whatsapp', site_id: ids.site_id }, custom_data: structuredClone(metadata) } };
      } };
    return q as any;
  });
});

it('reads only the stored pending receipt and idempotently stops exactly that poll', async () => {
  expect(await readRoutedTextOutcome(ids)).toMatchObject({ ...binding, message_id: ids.message_id, status: 'template_pending' });
  expect(writes).toBe(0);
  for (let i = 0; i < 2; i++) expect(await stopRoutedTextPoll(ids, binding)).toMatchObject({ status: 'needs_reconciliation', reconciliation_persisted: true });
  expect(writes).toBe(1);
  expect(metadata).toMatchObject({ tracking: 'untouched', needs_reconciliation: true, status: 'needs_reconciliation',
    [field]: { state: 'unknown', attempt_id: binding.attempt_id, template: { id: binding.template_id } } });
});

it.each(['template_id', 'attempt_id', 'provider', 'connection_id'])('a stale %s never stops the new poll', async key => {
  expect(await stopRoutedTextPoll(ids, { ...binding, [key]: 'not-the-saved-value' })).toMatchObject({ reconciliation_persisted: false });
  expect(writes).toBe(0);
});

it.each(['failed', 'sent', 'queued', 'delivered'])('honors a provider receipt (%s) even if the send response was lost', async status => {
  metadata.status = status; metadata[field].state = 'accepted'; metadata.provider_message_id = metadata[field].provider_message_id = 'provider';
  expect(await stopRoutedTextPoll(ids, binding)).toMatchObject({ status: status === 'failed' ? 'failed' : 'accepted', provider_message_id: 'provider' });
  expect(writes).toBe(0);
});

it.each(['attempting', 'ready', 'unknown'])('a %s claim never authorizes a send or a competing write', async state => {
  metadata[field].state = state;
  expect(await stopRoutedTextPoll(ids, binding)).toMatchObject({ status: 'needs_reconciliation' });
  expect(writes).toBe(0);
});

it('recognizes a live claim without overwriting the handler still awaiting a provider response', async () => {
  metadata[field].state = 'attempting'; metadata.status = 'placement_unknown';
  expect(await readRoutedTextOutcome(ids)).toMatchObject({ status: 'needs_reconciliation', recovery_action: 'observe' });
  expect(await stopRoutedTextPoll(ids, binding)).toMatchObject({ recovery_action: 'observe' });
  expect(writes).toBe(0);
});

it('fails closed on foreign scope, a corrupt receipt, or a race with an in-flight poll', async () => {
  await expect(stopRoutedTextPoll({ ...ids, site_id: 'other' }, binding)).rejects.toThrow('Scoped');
  loseCas = true;
  await expect(stopRoutedTextPoll(ids, binding)).rejects.toThrow('changed');
  metadata[field].state = 'accepted'; metadata[field].provider_message_id = 'mismatch';
  expect(await readRoutedTextOutcome(ids)).toMatchObject({ status: 'needs_reconciliation' });
  expect(writes).toBe(0);
});

it('recovers a persisted recipient preflight failure but never confuses it with placement', async () => {
  metadata = { status: 'failed', command_status: 'failed', error_code: 'WHATSAPP_RECIPIENT_UNVERIFIED' };
  expect(await readRoutedTextOutcome(ids)).toMatchObject({ success: false, status: 'failed' });
  metadata.provider_message_id = 'provider';
  expect(await readRoutedTextOutcome(ids)).toMatchObject({ success: false, status: 'needs_reconciliation' });
  expect(writes).toBe(0);
});