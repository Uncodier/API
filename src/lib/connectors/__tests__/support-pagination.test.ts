import { supportInput, type SupportConnectorScope } from '../support-runtime-contract';
import { discoverSupport } from '../support-runtime-discovery';
import { candidateWindow, supportInventory } from '../support-runtime-access';
import type { ReviewedConnectorTool } from '../reviewed-tools';

jest.mock('../support-runtime-access', () => ({candidateWindow: jest.fn(), supportInventory: jest.fn(), denied: () => new Error('Unavailable')}));

const account = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const scope: SupportConnectorScope = { audience: 'member', userId: account(50), siteId: account(51), agentId: account(52), conversationId: account(53), idempotencyKey: 'turn-1' };
const ids = Array.from({length: 13}, (_,i) => account(i + 1));
const tool = (i: number): ReviewedConnectorTool => ({ slug: `MAIL_${i}`, toolkit: 'gmail', description: 'Mail operations', domains: [], category: 'mail', requiredScreens: [], requiredScopes: [] });
const dataset = (id: string) => id === ids[6] ? Array.from({length: 350}, (_, i) => tool(i)) : [tool(0)];
const inventory = jest.fn(async (id: string) => ({tools: dataset(id), label: 'Test mailbox'}));
beforeEach(() => {
  jest.clearAllMocks();
  inventory.mockImplementation(async id => ({tools: dataset(id), label: 'Test mailbox'}));
  jest.mocked(supportInventory).mockReturnValue(inventory);
  jest.mocked(candidateWindow).mockImplementation(async (_scope, after, exact) => ids
    .filter(id => (!exact || id === exact) && id > after).slice(0, 6).map(id => ({id})));
});

test('crosses account and tool page boundaries without duplicates or missing entries, including a 350-tool account outside the first window', async () => {
  const expected = ids.flatMap(id => dataset(id).map(t => `connector:${id}:${t.slug}`));
  const found: string[] = [];
  let cursor: string | undefined;
  const contexts = new Set<string>();
  const recheck = jest.fn(async () => {});
  for (let page = 0; page < expected.length; page++) {
    const request = { action: 'search' as const, query: 'mail', cursor };
    expect(supportInput.safeParse(request).success).toBe(true);
    const result = await discoverSupport(scope, request, recheck);
    if (!('tools' in result)) throw new Error('Expected a tool page');
    expect(result.tools.length).toBeLessThanOrEqual(5);
    for (const summary of result.tools) {
      expect(Object.keys(summary).sort()).toEqual(['account_label','connector_id','description','name','toolkit']);
      found.push(summary.name!);
    }
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
    expect(contexts.has(cursor)).toBe(false);
    contexts.add(cursor);
  }
  expect(found.sort()).toEqual(expected.sort());
  expect(inventory.mock.calls.length).toBeLessThanOrEqual(5 * recheck.mock.calls.length);
});

test('a page with no matches is not the end when later accounts contain a match', async () => {
  inventory.mockImplementation(async id => ({tools: [id === ids[8] ? {...tool(90), description: 'Refunds'} : tool(0)], label: 'Test mailbox'}));
  const first = await discoverSupport(scope, {action: 'search', query: 'Refunds'}, async () => {});
  expect(first).toMatchObject({ tools: [] });
  expect(first.next_cursor).toEqual(expect.any(String));
  const second = await discoverSupport(scope, {action: 'search', query: 'Refunds', cursor: first.next_cursor!}, async () => {});
  expect(second).toMatchObject({ tools: [{ connector_id: ids[8] }] });
});

test('requires a new search when the account inventory changes mid-page', async () => {
  const filter = {action: 'list' as const, connector_id: ids[6]};
  const first = await discoverSupport(scope, filter, async () => {});
  inventory.mockImplementation(async () => ({tools: [tool(0)], label: 'Test mailbox'}));
  await expect(discoverSupport(scope, {...filter, cursor: first.next_cursor!}, async () => {})).rejects.toMatchObject({ code: 'STALE_CURSOR' });
});