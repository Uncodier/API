import { randomUUID } from 'node:crypto';

const single = jest.fn(), resolve = jest.fn();
const query: any = {};
for (const method of ['select', 'eq']) query[method] = jest.fn(() => query);
query.maybeSingle = single;
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(() => query) } }));
jest.mock('../plan-ownership', () => ({ resolveAssistantPlanOwnership: resolve }));
import { assertStandaloneCommandPlan } from '../command-plan-guard';

const site = randomUUID(), source = randomUUID(), runner = randomUUID(), planId = randomUUID();
beforeEach(() => {
  jest.clearAllMocks();
  single.mockResolvedValue({ data: { id: planId, instance_id: source, metadata: {} } });
  resolve.mockResolvedValue({ state: 'standalone' });
});

it.each([runner, 'default'])('rejects a foreign/default target instance without trusting omitted requirement_id', async target => {
  await expect(assertStandaloneCommandPlan({ action: 'update', plan_id: planId, instance_id: target }, site, source)).rejects.toThrow('sole runner');
  expect(single).not.toHaveBeenCalled();
});

it('resolves stored plan ownership when the model omits requirement_id', async () => {
  single.mockResolvedValue({ data: { id: planId, instance_id: source, metadata: { requirement_id: randomUUID() } } });
  await expect(assertStandaloneCommandPlan({ action: 'update', plan_id: planId }, site, source)).rejects.toThrow('sole runner');
  expect(query.eq).toHaveBeenCalledWith('site_id', site);
});

it('rejects stored foreign-instance plans even with no explicit instance_id', async () => {
  single.mockResolvedValue({ data: { id: planId, instance_id: runner, metadata: {} } });
  await expect(assertStandaloneCommandPlan({ action: 'update', plan_id: planId }, site, source)).rejects.toThrow();
});

it.each([{ state: 'managed', requirementId: randomUUID() }, { state: 'unavailable' }])('fails closed on requirement ownership or unavailable lookup', async ownership => {
  resolve.mockResolvedValue(ownership);
  await expect(assertStandaloneCommandPlan({ action: 'create' }, site, source)).rejects.toThrow();
});

it.each([{ data: null }, { data: { instance_id: source }, error: { message: 'Unavailable' } }])('fails closed on target lookup failure', async response => {
  single.mockResolvedValue(response);
  await expect(assertStandaloneCommandPlan({ action: 'update', plan_id: planId }, site, source)).rejects.toThrow();
});

it('preserves verified standalone edits and read-only listing', async () => {
  await assertStandaloneCommandPlan({ action: 'update', plan_id: planId }, site, source);
  expect(resolve).toHaveBeenCalledWith({ instanceId: source, siteId: site, planRequirementId: undefined });
  jest.clearAllMocks();
  await assertStandaloneCommandPlan({ action: 'list' }, site, source, randomUUID());
  expect(single).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
});