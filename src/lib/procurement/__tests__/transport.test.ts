import { randomUUID, randomBytes } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { dispatchProcurement } from '../transport';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn() } }));
const scope = { siteId: randomUUID(), userId: randomUUID() };
beforeEach(() => jest.clearAllMocks());

it('passes only host-owned scope to the named service-only bridge', async () => {
  (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ data: { requests: [] }, error: null });
  await expect(dispatchProcurement(scope, 'requests.list', { limit: 10 })).resolves.toEqual({ requests: [] });
  expect(supabaseAdmin.rpc).toHaveBeenCalledWith('procurement_mcp_dispatch', { p_site: scope.siteId, p_actor: scope.userId, p_operation: 'requests.list', p_args: { limit: 10 } });
});

it.each([['40001', 'conflict', 409], ['PT409', 'conflict', 409], ['42501', 'forbidden', 403], ['22023', 'invalid_transition', 400], ['PGRST202', 'migration_required', 503], ['P0002', 'not_found', 404], ['55000', 'not_ready', 409], ['XX000', 'unavailable', 503]])('maps SQL %s safely', async (sql, code, status) => {
  const sensitive = randomBytes(24).toString('hex');
  (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ error: { code: sql, message: sensitive, details: sensitive } });
  const error = await dispatchProcurement(scope, 'tenders.list', {}).catch(e => e);
  expect(error).toMatchObject({ code, status });
  expect(error.message).not.toContain(sensitive);
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
});

it('reports uncertain network outcome without retrying writes or logging raw errors', async () => {
  const sensitive = randomBytes(24).toString('hex');
  (supabaseAdmin.rpc as jest.Mock).mockRejectedValue(new Error(sensitive));
  const error = await dispatchProcurement(scope, 'orders.receive', {}).catch(e => e);
  expect(error).toMatchObject({ code: 'outcome_unknown', status: 503 });
  expect(error.message).not.toContain(sensitive);
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
});