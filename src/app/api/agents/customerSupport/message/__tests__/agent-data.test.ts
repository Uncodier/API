const mockQuery: any = {};
const mockResult = jest.fn();
for (const method of ['schema', 'from', 'select', 'eq', 'order']) {
  mockQuery[method] = () => mockQuery;
}
mockQuery.limit = mockResult;
mockQuery.single = mockResult;
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { schema: () => mockQuery },
}));
import { findActiveCustomerSupportAgent, getAgentInfo } from '../agent-data';

const id = '00000000-0000-4000-8000-000000000001';
describe('support agent lookup failures', () => {
  it.each([findActiveCustomerSupportAgent, getAgentInfo])('propagates database errors %#', async lookup => {
    const error = new Error('database unavailable');
    mockResult.mockResolvedValueOnce({ data: null, error });
    await expect(lookup(id)).rejects.toBe(error);
  });
  it('returns null only for a successful empty active-agent lookup', async () => {
    mockResult.mockResolvedValueOnce({ data: [], error: null });
    await expect(findActiveCustomerSupportAgent(id)).resolves.toBeNull();
  });
});