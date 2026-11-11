import { supabaseAdmin } from '@/lib/database/supabase-client';
import { dispatchNativeMedia } from '../native-media-delivery';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
let row: any;
const input = { site_id: 'site', message_id: 'original', conversation_id: 'conversation' };
beforeEach(() => {
  row = { id: 'original', role: 'assistant', content: '', conversation_id: 'conversation', custom_data: {
    status: 'sending', message_type: 'image', media_url: 'https://media.example.test/photo.png', approval: true,
  } };
  jest.mocked(supabaseAdmin.from).mockImplementation(() => {
    let update: any;
    let expected: string | undefined;
    const execute = async () => {
      if (update) {
        if (expected && expected !== JSON.stringify(row.custom_data)) return { data: null };
        row.custom_data = update.custom_data;
        return { data: { id: row.id } };
      }
      return { data: structuredClone(row) };
    };
    const query: any = { select: () => query, eq: (key: string, value: string) => {
      if (key === 'custom_data') expected = value;
      return query;
    }, is: () => query, update: (value: any) => { update = value; return query; }, maybeSingle: execute };
    return query;
  });
});
it('updates the original message receipt without losing attachment or approval metadata', async () => {
  const send = jest.fn(async () => ({ id: 'provider' }));
  await dispatchNativeMedia(input, 'smtp', send, result => ({ id: result.id }));
  expect(row.custom_data).toMatchObject({ status: 'sent', provider_message_id: 'provider', approval: true,
    message_type: 'image', native_media_delivery: { provider: 'smtp', state: 'accepted' } });
  await expect(dispatchNativeMedia(input, 'smtp', send, result => ({ id: result.id }))).rejects.toThrow('reconciliation');
  expect(send).toHaveBeenCalledTimes(1);
});
it('blocks another provider attempt even after recovery resets an ambiguous send to accepted', async () => {
  const send = jest.fn(async () => { throw new Error('timeout after acceptance'); });
  await expect(dispatchNativeMedia(input, 'twilio', send, () => ({}))).rejects.toThrow('timeout');
  expect(row.custom_data.status).toBe('reconciliation_required');
  row.custom_data.status = 'accepted';
  await expect(dispatchNativeMedia(input, 'twilio', send, () => ({}))).rejects.toThrow('reconciliation');
  expect(send).toHaveBeenCalledTimes(1);
});
it('serializes concurrent attempts with a compare-and-set claim', async () => {
  const send = jest.fn(async () => ({ id: 'provider' }));
  const outcomes = await Promise.allSettled([1, 2].map(() => dispatchNativeMedia(input, 'zavu', send, result => ({ id: result.id }))));
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(send).toHaveBeenCalledTimes(1);
});
it('keeps Outstand acceptance pending, rather than asserting final delivery', async () => {
  await dispatchNativeMedia(input, 'outstand', async () => 'provider', id => ({ id, status: 'pending' }));
  expect(row.custom_data).toMatchObject({ status: 'pending', provider_message_id: 'provider' });
});
it('makes missing provider receipts sticky and rejects unapproved messages before sending', async () => {
  await expect(dispatchNativeMedia(input, 'smtp', async () => ({}), () => ({}))).rejects.toThrow('confirm acceptance');
  expect(row.custom_data.status).toBe('reconciliation_required');
  row.custom_data = { status: 'pending' };
  const send = jest.fn();
  await expect(dispatchNativeMedia(input, 'smtp', send, () => ({}))).rejects.toThrow('unapproved');
  expect(send).not.toHaveBeenCalled();
});
it('rejects inbound user messages and previously suppressed sends before dispatch', async () => {
  const send = jest.fn();
  row.role = 'user';
  await expect(dispatchNativeMedia(input, 'smtp', send, () => ({}))).rejects.toThrow('scope');
  row.role = 'assistant';
  row.custom_data.automation_skipped = true;
  await expect(dispatchNativeMedia(input, 'smtp', send, () => ({}))).rejects.toThrow('suppressed');
  expect(send).not.toHaveBeenCalled();
});
it('rejects an attachment changed between preflight and the dispatch claim', async () => {
  const send = jest.fn();
  await expect(dispatchNativeMedia({ ...input, media_url: 'https://media.example.test/old.png', message_type: 'image' }, 'zavu', send, () => ({})))
    .rejects.toThrow('attachment changed');
  expect(send).not.toHaveBeenCalled();
});
it('leaves the claim sticky if the provider succeeds but receipt persistence fails', async () => {
  const send = jest.fn(async () => {
    jest.mocked(supabaseAdmin.from).mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ error: new Error('database unavailable') }) }) }) } as any);
    return 'provider';
  });
  await expect(dispatchNativeMedia(input, 'smtp', send, id => ({ id }))).rejects.toThrow('receipt requires reconciliation');
  expect(row.custom_data).toMatchObject({ status: 'reconciliation_required', native_media_delivery: { state: 'attempting' } });
  expect(send).toHaveBeenCalledTimes(1);
});