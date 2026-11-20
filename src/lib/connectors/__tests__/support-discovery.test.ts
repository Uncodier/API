import { discoverSupport } from '../support-runtime-discovery';
import { candidateWindow, supportInventory } from '../support-runtime-access';
import type { ReviewedConnectorTool } from '../reviewed-tools';

jest.mock('../support-runtime-access', () => ({ candidateWindow: jest.fn(), supportInventory: jest.fn(), denied: () => new Error('Unavailable') }));
const id = '10000000-0000-4000-8000-000000000001';
const scope = { siteId: id, agentId: id, conversationId: id, userId: id, audience: 'member' as const, idempotencyKey: 'turn' };
const recheck = jest.fn(async () => {});
const tools: ReviewedConnectorTool[] = Array.from({ length: 350 }, (_, index) => ({ slug: `MAIL_READ_${index}`,
  toolkit: 'gmail', description: index === 281 ? 'Find archived invoices' : 'Read mailbox', domains: [], category: 'email', requiredScreens: [], requiredScopes: [] }));
const inventory = jest.fn(async () => ({ tools, label: 'Support account' }));
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(candidateWindow).mockResolvedValue([{ id }]);
  jest.mocked(supportInventory).mockReturnValue(inventory);
});

it('lists an account once and searches hundreds of eligible tools without describing or authorizing them individually', async () => {
  const catalog = await discoverSupport(scope, { action: 'list' }, recheck);
  expect(catalog).toMatchObject({ connectors: [{ connector_id: id, description: 'Email and mailbox operations.' }] });
  expect(JSON.stringify(catalog)).not.toContain('MAIL_READ_');
  const search = await discoverSupport(scope, { action: 'search', query: 'archived invoices' }, recheck);
  expect(search).toMatchObject({ tools: [{ name: `connector:${id}:MAIL_READ_281` }], next_cursor: null });
  expect(inventory).toHaveBeenCalledTimes(2);
  expect(recheck).toHaveBeenCalledTimes(2);
});

it('pages through one large account in bounded summaries; cursors are bound to the host turn and filters', async () => {
  const filter = { action: 'list' as const, connector_id: id };
  const first = await discoverSupport(scope, filter, recheck);
  expect(first).toMatchObject({ tools: Array.from({length: 5}, () => ({ connector_id: id })) });
  expect(first.next_cursor!.length).toBeLessThanOrEqual(128);
  const cursor = first.next_cursor!;
  const second = await discoverSupport(scope, { ...filter, cursor }, recheck);
  const names = [first, second].flatMap(page => 'tools' in page ? page.tools!.map(tool => tool.name) : []);
  expect(new Set(names).size).toBe(10);
  expect(JSON.stringify(second)).not.toContain('requiredScopes');
  await expect(discoverSupport({ ...scope, idempotencyKey: 'different' }, { ...filter, cursor }, recheck)).rejects.toThrow();
  await expect(discoverSupport(scope, { action: 'search', query: 'mail', cursor }, recheck)).rejects.toThrow();
});