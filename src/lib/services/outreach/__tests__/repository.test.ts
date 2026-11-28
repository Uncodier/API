jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('../transport', () => ({ prepareOutreachDelivery: jest.fn() }));
jest.mock('@/lib/utils/redis-client', () => ({ getRedisClient: jest.fn() }));
import { outreachRepository } from '../delivery';
import { supabaseAdmin } from '@/lib/database/supabase-client';

describe('outreach history', () => {
  const rpc = supabaseAdmin.rpc as jest.Mock;
  const page = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
  beforeEach(() => rpc.mockReset());

  test('keeps tenant and lead scope on every page and resumes after the last ID', async () => {
    const order = jest.fn().mockResolvedValueOnce({ data: page }).mockResolvedValueOnce({ data: [{ id: 'last' }] });
    rpc.mockReturnValue({ order });
    expect(await outreachRepository.history('site', 'lead')).toEqual([...page, { id: 'last' }]);
    expect(rpc.mock.calls).toEqual([null, '999'].map(cursor => ['outreach_history_page', {
      p_site_id: 'site', p_lead_id: 'lead', p_after_id: cursor,
    }]));
    expect(order.mock.calls).toEqual([['id'], ['id']]);
  });

  test('never treats a failed later page as a complete history', async () => {
    rpc.mockReturnValue({ order: jest.fn().mockResolvedValueOnce({ data: page }).mockResolvedValueOnce({ error: new Error('timeout') }) });
    await expect(outreachRepository.history('site', 'lead')).rejects.toThrow('timeout');
  });

  test('still fails closed at 20,000 rows', async () => {
    rpc.mockReturnValue({ order: jest.fn().mockResolvedValue({ data: page }) });
    await expect(outreachRepository.history('site', 'lead')).rejects.toThrow('too large');
    expect(rpc).toHaveBeenCalledTimes(20);
  });
});

test('repository verifies both conversation and lead tenant, rejecting inconsistent message lead linkage', async () => {
  const filters: any[] = [];
  const records: Record<string, any> = {
    messages: { id: 'm', conversation_id: 'c', lead_id: 'l' }, conversations: { id: 'c', lead_id: 'l', site_id: 'site' },
    leads: { id: 'l', site_id: 'site' }, settings: {},
  };
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => {
    const query: any = { select: () => query, eq: (key: string, value: string) => { filters.push([table, key, value]); return query; },
      order: () => query, range: async () => ({ data: [records.conversations] }), maybeSingle: async () => ({ data: records[table] }) };
    return query;
  });
  expect(await outreachRepository.load('site', 'm')).toMatchObject({ lead: { id: 'l' } });
  expect(filters).toContainEqual(['conversations', 'site_id', 'site']);
  expect(filters).toContainEqual(['leads', 'site_id', 'site']);
  records.messages.lead_id = 'different-lead';
  expect(await outreachRepository.load('site', 'm')).toBeNull();
});
test('central accepted-call marker preserves voice terminal callback status and metadata', async () => {
  const latest = { status: 'failed', call_status: 'no_answer', voice_mode: 'agent_call', provider_call_id: 'call', duration_seconds: 12,
    outreach_delivery: { state: 'dispatching', attempt_id: 'attempt' } };
  const update = jest.fn();
  (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
    const q: any = { select: () => q, eq: () => q, single: async () => ({ data: { custom_data: latest } }),
      update: (payload: any) => { update(payload); return q; }, then: (resolve: any) => Promise.resolve(resolve({ data: [{ id: 'message' }] })) };
    return q;
  });
  await outreachRepository.mark({ id: 'message', conversation_id: 'conversation' }, { state: 'sent', attempt_id: 'attempt', provider_message_id: 'call', sent_at: '2026-09-29T12:00:00Z' });
  expect(update).toHaveBeenCalledWith({ custom_data: expect.objectContaining({ status: 'failed', call_status: 'no_answer', duration_seconds: 12,
    provider_call_id: 'call', outreach_delivery: expect.objectContaining({ state: 'sent' }) }) });
});