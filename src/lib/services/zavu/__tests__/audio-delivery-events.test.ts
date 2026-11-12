import { createHash } from 'node:crypto';
import { reconcileAudioDeliveryEvent } from '../audio-delivery-events';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { audioSenderIdentity } from '../../channels/audio-sender-identity';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
let row: any;
let sites: any[];
let active: any[];
let writes: number;
let lookupError: boolean;
let loseClaim: boolean;
let collision: boolean;
const event = (state: string) => ({ type: `message.${state}`, senderId: 'sender', timestamp: 123,
  data: { channel: 'telegram', messageId: 'provider', to: 'recipient', errorCode: 'rejected' } });
beforeEach(() => {
  writes = 0; active = []; lookupError = false; loseClaim = false; collision = false;
  sites = [{ site_id: 'site', channels: { connections: [{ id: 'connection', type: 'telegram', zavu_sender_id: 'sender' }] } }];
  row = { id: 'message', role: 'assistant', content: 'Hello', conversation_id: 'conversation',
    conversations: { site_id: 'site', channel: 'telegram' }, custom_data: { status: 'sent', connection_id: 'connection',
      audio_delivery: { state: 'sent', provider_message_id: 'provider', sender_id: 'sender',
        site_id: 'site', channel: 'telegram', recipient: 'recipient', provider: 'zavu' } } };
  jest.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    let value: any; const filters: Record<string, any> = {};
    const run = async () => {
      if (table === 'settings') return { data: sites };
      if (value) {
        if (loseClaim || filters.custom_data !== JSON.stringify(row.custom_data)) return { data: null };
        row.custom_data = value.custom_data; writes++; return { data: { id: 'message' } };
      }
      expect(filters['conversations.site_id']).toBe('site');
      if (lookupError) return { data: null, error: { message: 'offline' } };
      if (filters['custom_data->audio_delivery->>state']) return { data: active };
      return { data: row ? collision ? [row, row] : [structuredClone(row)] : [] };
    };
    const q: any = { select: () => q, contains: () => q, eq: (key: string, v: any) => { filters[key] = v; return q; },
      limit: () => q, update: (v: any) => { value = v; return q; }, maybeSingle: run,
      then: (resolve: any, reject: any) => run().then(resolve, reject) };
    return q;
  });
});
it('keeps failure above sent/queued but permits subsequent confirmed delivery/read', async () => {
  await reconcileAudioDeliveryEvent(event('failed'));
  await reconcileAudioDeliveryEvent(event('sent'));
  await reconcileAudioDeliveryEvent(event('queued'));
  await reconcileAudioDeliveryEvent(event('failed'));
  expect(writes).toBe(1);
  expect(row.custom_data).toMatchObject({ status: 'failed', command_status: 'failed',
    audio_delivery: { state: 'failed', failure_code: 'rejected', provider_message_id: 'provider' } });
  await reconcileAudioDeliveryEvent(event('delivered'));
  await reconcileAudioDeliveryEvent(event('read'));
  await reconcileAudioDeliveryEvent(event('failed'));
  expect(writes).toBe(3);
  expect(row.custom_data).toMatchObject({ status: 'delivered', command_status: 'completed', error_message: null,
    audio_delivery: { state: 'read', failure_code: null } });
});
it.each(['sender', 'recipient', 'site', 'channel', 'provider', 'role'])('rejects a mismatched %s', async field => {
  if (field === 'role') row.role = 'user';
  else row.custom_data.audio_delivery[`${field}${['sender', 'site'].includes(field) ? '_id' : ''}`] = 'foreign';
  await reconcileAudioDeliveryEvent(event('failed'));
  expect(writes).toBe(0);
});
it('does not apply incomplete or ambiguous signed identities', async () => {
  await reconcileAudioDeliveryEvent({ ...event('failed'), data: { ...event('failed').data, to: undefined } });
  sites.push(sites[0]);
  await reconcileAudioDeliveryEvent(event('failed'));
  expect(writes).toBe(0);
});
function legacy(text = 'Hello') {
  const sender = audioSenderIdentity({ provider: 'zavu', senderId: 'sender' });
  row.content = text;
  row.custom_data.audio_delivery = { state: 'sent', provider_message_id: 'provider',
    key: createHash('sha256').update(JSON.stringify({ text, channel: 'telegram', to: 'recipient', sender })).digest('hex') };
}
it('verifies the raw saved markdown content used by the delivery key', async () => {
  legacy('**Hello**');
  await reconcileAudioDeliveryEvent(event('delivered'));
  expect(writes).toBe(1);
});
it('reconciles legacy receipts only with a saved exact connection and verified destination hash', async () => {
  legacy();
  await reconcileAudioDeliveryEvent({ ...event('failed'), data: { ...event('failed').data, to: 'other' } });
  expect(writes).toBe(0);
  await reconcileAudioDeliveryEvent(event('delivered'));
  expect(writes).toBe(1);
});
it.each(['missing', 'stale', 'duplicate', 'twilio', 'hash'])('rejects unsafe legacy binding: %s', async kind => {
  legacy();
  if (kind === 'missing') delete row.custom_data.connection_id;
  if (kind === 'stale') row.custom_data.connection_id = 'other';
  if (kind === 'duplicate') sites[0].channels.connections.push(sites[0].channels.connections[0]);
  if (kind === 'twilio') row.custom_data.connection_id = 'legacy:whatsapp';
  if (kind === 'hash') row.custom_data.audio_delivery.key = 'wrong';
  await reconcileAudioDeliveryEvent(event('failed'));
  expect(writes).toBe(0);
});
it('retries early callbacks without attaching a provider ID by recipient', async () => {
  row.custom_data.audio_delivery.state = 'dispatching';
  delete row.custom_data.audio_delivery.provider_message_id;
  active = [row]; row = null;
  await expect(reconcileAudioDeliveryEvent(event('failed'))).rejects.toThrow('not yet available');
  expect(active[0].custom_data.audio_delivery.provider_message_id).toBeUndefined();
  expect(writes).toBe(0);
  row = active[0];
  row.custom_data.audio_delivery = { ...row.custom_data.audio_delivery, state: 'sent', provider_message_id: 'provider' };
  await reconcileAudioDeliveryEvent(event('failed'));
  expect(row.custom_data.audio_delivery.state).toBe('failed');
  expect(writes).toBe(1);
});
it('retries legacy dispatch races too, but ignores unrelated recipient callbacks', async () => {
  legacy(); row.custom_data.audio_delivery.state = 'dispatching';
  active = [row]; row = null;
  await reconcileAudioDeliveryEvent({ ...event('sent'), data: { ...event('sent').data, to: 'other' } });
  await expect(reconcileAudioDeliveryEvent(event('sent'))).rejects.toThrow('not yet available');
});
it('retries lookup, ambiguous receipt, and CAS failures', async () => {
  lookupError = true;
  await expect(reconcileAudioDeliveryEvent(event('failed'))).rejects.toThrow('lookup unavailable');
  lookupError = false; collision = true;
  await expect(reconcileAudioDeliveryEvent(event('failed'))).rejects.toThrow('ambiguous');
  collision = false; loseClaim = true;
  await expect(reconcileAudioDeliveryEvent(event('failed'))).rejects.toThrow('concurrently');
});