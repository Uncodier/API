import { reconcileTemplateDeliveryEvent } from '../template-delivery-events';
import { supabaseAdmin } from '@/lib/database/supabase-client';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
let row: any;
let sites: any[];
let writes: number;
let dispatching: boolean;
let lookupError: boolean;
let loseClaim: boolean;
const event = (state: string) => ({ type: `message.${state}`, senderId: 'sender', timestamp: 123,
  data: { channel: 'whatsapp', messageId: 'provider', to: '+15555550100', errorCode: 'rejected' } });
beforeEach(() => {
  writes = 0; sites = [{ site_id: 'site' }]; dispatching = false; lookupError = false; loseClaim = false;
  row = { id: 'message', conversation_id: 'conversation', custom_data: { status: 'queued', response_format: 'audio',
    template_delivery: { state: 'accepted', delivery_status: 'queued', provider_message_id: 'provider',
      sender_id: 'sender', recipient: '+15555550100' } } };
  jest.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    let value: any; const filters: Record<string, any> = {};
    const run = async () => {
      if (table === 'settings') return { data: sites };
      expect(filters['conversations.site_id'] || value).toBeTruthy();
      if (value) {
        if (loseClaim) return { data: null };
        if (filters.custom_data !== JSON.stringify(row.custom_data)) return { data: null };
        row.custom_data = value.custom_data; writes++; return { data: { id: 'message' } };
      }
      if (lookupError) return { data: null, error: { message: 'offline' } };
      if (filters['custom_data->template_delivery->>state'] === 'dispatching') return { data: dispatching ? [{ id: 'active' }] : [] };
      return { data: row ? [structuredClone(row)] : [] };
    };
    const q: any = { select: () => q, contains: () => q, eq: (key: string, v: any) => { filters[key] = v; return q; },
      limit: () => q, update: (v: any) => { value = v; return q; }, maybeSingle: run,
      then: (resolve: any, reject: any) => run().then(resolve, reject) };
    return q;
  });
});
it('persists asynchronous provider rejection after acceptance and keeps the no-resend receipt', async () => {
  await reconcileTemplateDeliveryEvent(event('failed'));
  expect(row.custom_data).toMatchObject({ status: 'failed', command_status: 'failed',
    template_delivery: { state: 'failed', delivery_status: 'failed', provider_message_id: 'provider', failure_code: 'rejected' } });
  await reconcileTemplateDeliveryEvent(event('sent'));
  expect(row.custom_data.status).toBe('failed');
  expect(writes).toBe(1);
});
it('advances sent/delivered/read monotonically and ignores out-of-order failures after confirmed delivery', async () => {
  await reconcileTemplateDeliveryEvent(event('sent'));
  expect(row.custom_data.status).toBe('sent');
  await reconcileTemplateDeliveryEvent(event('delivered'));
  await reconcileTemplateDeliveryEvent(event('queued'));
  await reconcileTemplateDeliveryEvent(event('failed'));
  expect(row.custom_data.template_delivery.state).toBe('delivered');
  await reconcileTemplateDeliveryEvent(event('read'));
  expect(row.custom_data).toMatchObject({ status: 'delivered', template_delivery: { state: 'read' } });
  expect(writes).toBe(3);
});
it('deduplicates repeated events and never applies a foreign sender or recipient', async () => {
  await reconcileTemplateDeliveryEvent({ ...event('failed'), senderId: 'other' });
  await reconcileTemplateDeliveryEvent({ ...event('failed'), data: { ...event('failed').data, to: '+15555550101' } });
  expect(writes).toBe(0);
  await reconcileTemplateDeliveryEvent(event('failed'));
  await reconcileTemplateDeliveryEvent(event('failed'));
  expect(writes).toBe(1);
});
it('does not lose an event arriving before the dispatch response persists its provider ID', async () => {
  row = null; dispatching = true;
  await expect(reconcileTemplateDeliveryEvent(event('failed'))).rejects.toThrow('not yet available');
  expect(writes).toBe(0);
});
it('ignores unrelated messages but retries database and concurrent-write failures', async () => {
  const saved = row; row = null;
  await reconcileTemplateDeliveryEvent(event('sent'));
  row = saved; lookupError = true;
  await expect(reconcileTemplateDeliveryEvent(event('sent'))).rejects.toThrow('lookup unavailable');
  lookupError = false; loseClaim = true;
  await expect(reconcileTemplateDeliveryEvent(event('failed'))).rejects.toThrow('concurrently');
});
it('rejects ambiguous site mapping and other channels without writes', async () => {
  sites = [{ site_id: 'site' }, { site_id: 'other' }];
  await reconcileTemplateDeliveryEvent(event('failed'));
  await reconcileTemplateDeliveryEvent({ ...event('failed'), data: { ...event('failed').data, channel: 'sms' } });
  expect(writes).toBe(0);
});