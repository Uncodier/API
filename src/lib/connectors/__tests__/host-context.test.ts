import { randomUUID } from 'node:crypto';
import { assistantConnectorContext } from '../host-context';
import { requireConnectorSiteAccess } from '../account-access';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('../account-access', () => ({ requireConnectorSiteAccess: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
const agentId = randomUUID();
const scope = { agentId, siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(), host: 'assistant' as const };
let query: Record<string, jest.Mock>;

beforeEach(() => {
  jest.clearAllMocks();
  query = { select: jest.fn(), eq: jest.fn(), abortSignal: jest.fn(), maybeSingle: jest.fn() };
  for (const key of ['select', 'eq', 'abortSignal']) query[key].mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: { agent_id: agentId }, error: null });
  jest.mocked(supabaseAdmin.from).mockReturnValue(query as any);
});

test('uses pinned prompt identity, not browser-writable instance agent, refreshed on every call', async () => {
  const resolve = assistantConnectorContext(scope);
  expect(await resolve()).toMatchObject({ ...scope, agentId });
  expect(requireConnectorSiteAccess).toHaveBeenCalledWith(scope.siteId, scope.userId);
  expect(supabaseAdmin.from).toHaveBeenCalledWith('remote_instances');
  expect(query.select.mock.calls).toEqual([['id'], ['id']]);
  expect(query.eq.mock.calls).toContainEqual(['id', agentId]);
  query.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
  await expect(resolve()).rejects.toMatchObject({ code: 'AGENT_REQUIRED' });
});

test('unsupported/background host and missing human cannot read a substitute identity', async () => {
  await expect(assistantConnectorContext({ ...scope, host: 'workflow' })()).rejects.toMatchObject({ code: 'HOST_DISABLED' });
  await expect(assistantConnectorContext({ ...scope, userId: undefined })()).rejects.toMatchObject({ code: 'AGENT_REQUIRED' });
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

test.each([{ data: null, error: null }, { data: null, error: { code: '42703' } }])('missing instance/schema fails closed without plan/robot/role fallback', async result => {
  query.maybeSingle.mockResolvedValue(result);
  await expect(assistantConnectorContext(scope)()).rejects.toBeInstanceOf(Error);
  expect(supabaseAdmin.from).toHaveBeenCalledTimes(1);
});