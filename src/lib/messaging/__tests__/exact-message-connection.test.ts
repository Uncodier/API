jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveExactMessageConnection } from '../exact-message-connection';
let message: any;
let conversation: any;
let channels: any;
beforeEach(() => {
  message = { conversation_id: 'conversation', role: 'assistant', custom_data: { connection_id: 'selected', channel: 'sms' } };
  conversation = { site_id: 'site', channel: 'sms' };
  channels = { connections: [{ id: 'selected', type: 'sms', status: 'connected', zavu_sender_id: 'sender' }, { id: 'first', type: 'sms', status: 'connected', zavu_sender_id: 'other' }] };
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const q: any = {}; q.select = q.eq = () => q;
    q.maybeSingle = async () => ({ data: table === 'messages' ? message : conversation, error: null }); return q;
  });
});
test('prepare/result exact persisted selection beats multiple same-type connections', async () => {
  expect(await resolveExactMessageConnection('site', 'sms', channels, 'message', 'conversation')).toEqual({ present: true, connectionId: 'selected' });
});
test('disabled retry, changed channel, foreign site, and mismatched conversation refuse instead of falling back', async () => {
  channels.connections[0].enabled = false;
  await expect(resolveExactMessageConnection('site', 'sms', channels, 'message')).rejects.toThrow();
  channels.connections[0].enabled = true; conversation.channel = 'email';
  await expect(resolveExactMessageConnection('site', 'sms', channels, 'message')).rejects.toThrow();
  conversation.channel = 'sms'; conversation.site_id = 'foreign';
  await expect(resolveExactMessageConnection('site', 'sms', channels, 'message')).rejects.toThrow();
  conversation.site_id = 'site';
  await expect(resolveExactMessageConnection('site', 'sms', channels, 'message', 'wrong')).rejects.toThrow();
});