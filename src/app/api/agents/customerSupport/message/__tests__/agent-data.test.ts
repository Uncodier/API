const mockQuery: any = {};
const mockResult = jest.fn();
for (const method of ['schema', 'from', 'select', 'eq', 'or', 'order']) {
  mockQuery[method] = jest.fn(() => mockQuery);
}
mockQuery.limit = mockResult;
mockQuery.maybeSingle = mockResult;
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { schema: () => mockQuery },
}));
import { findActiveCustomerSupportAgent, getAgentInfo } from '../agent-data';

const id = '00000000-0000-4000-8000-000000000001';
describe('support agent lookup failures', () => {
  it.each([findActiveCustomerSupportAgent, getAgentInfo])('propagates database errors %#', async lookup => {
    const error = new Error('database unavailable');
    mockResult.mockResolvedValueOnce({ data: null, error });
    await expect(lookup(id, id)).rejects.toBe(error);
  });
  it('returns null only for a successful empty active-agent lookup', async () => {
    mockResult.mockResolvedValueOnce({ data: [], error: null });
    await expect(findActiveCustomerSupportAgent(id)).resolves.toBeNull();
  });
});
// The origin predicate must run in PostgREST: filtering after limit(1) hides the legacy row.
it('looks up the newest created active legacy Support, retaining NULL/missing origins', async () => {
  jest.clearAllMocks();
  mockResult.mockResolvedValueOnce({ data: [{ id: 'legacy', user_id: 'owner' }], error: null });
  await expect(findActiveCustomerSupportAgent(id)).resolves.toEqual({ agentId: 'legacy', userId: 'owner' });
  expect(mockQuery.eq.mock.calls).toEqual([['site_id', id], ['role', 'Customer Support'], ['status', 'active']]);
  expect(mockQuery.or).toHaveBeenCalledWith('configuration->>agentOrigin.is.null,configuration->>agentOrigin.neq.independent');
  expect(mockQuery.order).toHaveBeenCalledWith('created_at', { ascending: false });
  expect(mockQuery.limit).toHaveBeenCalledWith(1);
});
