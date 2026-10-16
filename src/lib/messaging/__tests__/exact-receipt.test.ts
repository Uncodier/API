jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { claimExactDelivery, finishExactDelivery } from '../exact-delivery-receipt';
let message: any;
let casMatches: boolean;
beforeEach(() => {
  message = { id: 'message', role: 'assistant', conversation_id: 'conversation', custom_data: { connection_id: 'selected', status: 'sending' } };
  casMatches = true;
  (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
    let update: any; const q: any = {};
    q.select = () => q;
    q.eq = (key: string, value: unknown) => {
      if (key === 'custom_data') {
        expect(typeof value).toBe('string');
        expect(JSON.parse(value as string)).toEqual(message.custom_data);
      }
      return q;
    };
    q.update = (data: any) => { update = data; return q; };
    q.maybeSingle = async () => {
      if (update) {
        if (!casMatches) return { data: null, error: null };
        message = { ...message, ...update };
        return { data: { id: message.id }, error: null };
      }
      return { data: message, error: null };
    };
    return q;
  });
});
test('concurrent claim refuses before sending and unknown acceptance stays sticky', async () => {
  const attempt = await claimExactDelivery(message, 'selected');
  await expect(claimExactDelivery(message, 'selected')).rejects.toThrow();
  await finishExactDelivery('message', attempt, { success: false, delivery_attempted: true });
  expect(message.custom_data.exact_delivery_receipt.state).toBe('unknown');
  await expect(claimExactDelivery(message, 'selected')).rejects.toThrow();
});
test('lost compare-and-set and non-sending/user messages cannot claim', async () => {
  casMatches = false;
  await expect(claimExactDelivery(message, 'selected')).rejects.toThrow();
  casMatches = true;
  message.role = 'user'; await expect(claimExactDelivery(message, 'selected')).rejects.toThrow();
  message.role = 'assistant'; message.custom_data.status = 'sent';
  await expect(claimExactDelivery(message, 'selected')).rejects.toThrow();
});
test('accepted receipt persists provider ID and preserves selected routing', async () => {
  const attempt = await claimExactDelivery(message, 'selected');
  await finishExactDelivery('message', attempt, { success: true, messageId: 'provider-id' });
  expect(message.custom_data).toMatchObject({ status: 'sent', connection_id: 'selected', provider_message_id: 'provider-id', exact_delivery_receipt: { state: 'accepted' } });
});
test('pre-dispatch failure releases receipt; voice accepted keeps tracked webhook status', async () => {
  const attempt = await claimExactDelivery(message, 'selected');
  await finishExactDelivery('message', attempt, { success: false, delivery_attempted: false });
  expect(message.custom_data.exact_delivery_receipt).toBeUndefined();
  const voiceAttempt = await claimExactDelivery(message, 'selected'); message.custom_data.status = 'no_answer';
  await finishExactDelivery('message', voiceAttempt, { success: true, callId: 'call', messageId: 'call' });
  expect(message.custom_data.status).toBe('no_answer');
});