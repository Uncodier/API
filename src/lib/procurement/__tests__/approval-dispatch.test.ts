import { randomUUID } from 'node:crypto';
import { createProcurementTools } from '../tools';
import { defaultPolicyDocument } from '../policy/schemas';
import { assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';

jest.mock('@/app/api/agents/tools/router/screen-access', () => ({ assertToolScreenAccess: jest.fn() }));
const scope = { siteId: randomUUID(), userId: randomUUID() };
const target = randomUUID();
const rpc = jest.fn();
const context = () => {
  const document = defaultPolicyDocument();
  document.settings.fallback = { mode: 'none' };
  return { policy: { revision: 7, document }, target_id: target, target_version: 3,
    evaluated_at: new Date().toISOString(),
    actor_id: scope.userId, requester_id: scope.userId, currency: 'MXN', net_amount_minor: 100,
    lines: [{ id: randomUUID(), productId: null, categoryIds: [], netAmountMinor: 100 }],
    inherited_requirements: [], minimum_supplier_proposals: 0, supplier_proposals: 1 };
};
beforeEach(() => { jest.clearAllMocks(); (assertToolScreenAccess as jest.Mock).mockResolvedValue(undefined); });

it.each([
  ['procurement_requests', 'submit', 'requisition', { id: target, expected_revision: 3 }],
  ['procurement_tenders', 'publish', 'publication', { id: target, expected_version: 3 }],
  ['procurement_approvals', 'create', 'award', { target_id: target, expected_version: 3, event: 'award' }],
] as const)('runs trusted policy resolution before committing %s', async (name, action, event, args) => {
  rpc.mockResolvedValueOnce(context()).mockResolvedValueOnce({ valid: true }).mockResolvedValueOnce({ id: randomUUID(), status: 'pending' });
  const tool = createProcurementTools(scope, { rpc }).find(tool => tool.name === name)!;
  const result = await tool.execute({ action, ...args });
  expect(rpc.mock.calls[0]).toEqual([`context.${event}`, args]);
  expect(rpc.mock.calls[1]).toEqual(['policy.references', { policy_revision: 7 }]);
  expect(rpc.mock.calls[2]).toEqual([`${name.replace('procurement_', '')}.${action}`, {
    ...args, policy_revision: 7, plan: expect.objectContaining({ status: 'ready', simulationOnly: true, authorized: false }),
    expected_context: expect.objectContaining({ target_id: target, target_version: 3 }),
  }]);
  expect(assertToolScreenAccess).toHaveBeenCalledTimes(2);
  expect(result.data).toMatchObject({ status: 'pending' });
  expect(result).not.toHaveProperty('published');
});

it('rechecks revoked access after policy reads and never sends the committing call', async () => {
  (assertToolScreenAccess as jest.Mock).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
  rpc.mockResolvedValueOnce(context()).mockResolvedValueOnce({ valid: true });
  const tool = createProcurementTools(scope, { rpc }).find(tool => tool.name === 'procurement_tenders')!;
  await expect(tool.execute({ action: 'publish', id: target, expected_version: 3 })).rejects.toThrow('revoked');
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['context.publication', 'policy.references']);
});

it('never persists a plan from an unresolved policy', async () => {
  const blocked = context(); blocked.policy.document.settings.fallback = { mode: 'block' };
  rpc.mockResolvedValueOnce(blocked).mockResolvedValueOnce({ valid: true });
  const tool = createProcurementTools(scope, { rpc }).find(tool => tool.name === 'procurement_requests')!;
  await expect(tool.execute({ action: 'submit', id: target, expected_revision: 3 })).rejects.toThrow('blocked');
  expect(rpc).toHaveBeenCalledTimes(2);
});