import { randomUUID } from 'node:crypto';
import { discoverSupport } from '../support-runtime-discovery';
import { candidateWindow } from '../support-runtime-access';
import { memberDiscoveryTargets } from '../support-member-discovery';

jest.mock('../support-runtime-access', () => ({candidateWindow: jest.fn()}));
jest.mock('../support-member-discovery', () => ({memberDiscoveryTargets: jest.fn()}));

it('advances past a bounded window of ineligible accounts without disclosing their IDs', async () => {
  const scope = {audience: 'member' as const, siteId: randomUUID(), agentId: randomUUID(), conversationId: randomUUID(), userId: randomUUID(), idempotencyKey: 'turn'};
  const ids = Array.from({length: 7}, () => randomUUID()).sort();
  jest.mocked(candidateWindow).mockImplementation(async (_, after) => ids.filter(id => id > after).slice(0, 6).map(id => ({id})));
  jest.mocked(memberDiscoveryTargets).mockResolvedValue([]);
  const recheck = jest.fn(async () => {});
  const first = await discoverSupport(scope, {action: 'list'}, recheck);
  expect(first).toMatchObject({connectors: [], next_cursor: expect.any(String)});
  const cursor = first.next_cursor!;
  expect(ids.some(id => cursor.includes(id))).toBe(false);
  expect(await discoverSupport(scope, {action: 'list', cursor}, recheck)).toMatchObject({connectors: [], next_cursor: null});
  expect(jest.mocked(memberDiscoveryTargets).mock.calls.map(call => call[1])).toEqual([ids.slice(0, 5), ids.slice(5)]);
  expect(recheck).toHaveBeenCalledTimes(2);
});
