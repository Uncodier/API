import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { routeTools } from '@/app/api/agents/tools/router/assistantProtocol';
import { canUseToolScreen } from '@/app/api/agents/tools/router/screen-access';
import mapping from '@/app/api/agents/tools/router/tool-screen-map.json';
import { createProcurementTools } from '../tools';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/services/embeddings-service', () => ({
  EmbeddingsService: { generateEmbeddings: jest.fn().mockRejectedValue(new Error('offline')) },
}));

const scope = { siteId: randomUUID(), userId: randomUUID() };
const owner = randomUUID();
const screens = [
  ['procurement_requests', 'purchaseRequests'],
  ['procurement_tenders', 'procurementTenders'],
  ['procurement_quotations', 'purchasesQuotes'],
  ['procurement_orders', 'purchasesOrders'],
  ['procurement_approvals', 'procurementApprovals'],
  ['procurement_policy', 'procurementRules'],
] as const;
let blocked: string[];
let effective: boolean;
let role: string;
const dispatch = jest.fn();
const definitions = () => createProcurementTools(scope, { rpc: dispatch });
const router = () => routeTools(definitions(), scope).find(t => t.name === 'tools')!;

beforeEach(() => {
  jest.clearAllMocks(); blocked = []; effective = true; role = 'collaborator';
  dispatch.mockResolvedValue([]);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(() => ({ abortSignal: async () => ({ data: effective, error: null }) }));
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const query: any = {};
    for (const method of ['select', 'eq', 'abortSignal']) query[method] = () => query;
    query.maybeSingle = async () => ({ data: table === 'sites' ? { user_id: owner }
      : table === 'site_ownership' ? null : { role, blocked_screens: blocked }, error: null });
    return query;
  });
});
afterEach(() => jest.restoreAllMocks());

it.each(screens)('maps %s to its exact screen %s without an extra catalog role gate', (name, screen) => {
  expect(mapping.tools[name]).toEqual({ screens: [screen], requiresUser: true, bindActor: true });
  expect(canUseToolScreen(name, { isAdmin: false, blockedScreens: [] })).toBe(true);
  expect(canUseToolScreen(name, { isAdmin: false, blockedScreens: [screen] })).toBe(false);
  expect(canUseToolScreen(name, null)).toBe(false);
});

it.each(screens)('hides %s in list/search/describe and denies every action when %s is blocked', async (name, screen) => {
  blocked = [screen];
  const routed = router();
  const listed = await routed.execute({ action: 'list', category: 'commerce' });
  expect(listed.tools.map((t: any) => t.name)).not.toContain(name);
  expect(listed.count).toBe(screens.length - 1);
  const searched = await routed.execute({ action: 'search', query: name });
  expect(searched.tools.map((t: any) => t.name)).not.toContain(name);
  const described = await routed.execute({ action: 'describe', name });
  expect(described).toMatchObject({ status: 403 });
  expect(described).not.toHaveProperty('parameters');
  const direct = definitions().find(t => t.name === name)!;
  for (const action of direct.parameters.properties.action.enum) {
    expect(await routed.execute({ action: 'call', name, args: JSON.stringify({ action }) })).toMatchObject({ status: 403 });
    await expect(direct.execute({ action })).rejects.toMatchObject({ code: 'TOOL_SCREEN_ACCESS_DENIED' });
  }
  expect(dispatch).not.toHaveBeenCalled();
});

it.each(screens)('allows discovery and dispatch for %s when only its screen is enabled', async (name, screen) => {
  blocked = screens.map(([, key]) => key).filter(key => key !== screen);
  const routed = router();
  expect(await routed.execute({ action: 'list', category: 'commerce' })).toMatchObject({ count: 1, tools: [{ name }] });
  expect(await routed.execute({ action: 'describe', name })).toMatchObject({ success: true, name });
  const action = name === 'procurement_policy' ? 'get' : 'list';
  expect(await routed.execute({ action: 'call', name, args: JSON.stringify({ action }) })).toMatchObject({ success: true });
  expect(dispatch).toHaveBeenCalledTimes(1);
  // Dispatch is mocked here. Canonical SQL independently checks business roles;
  // screen access is not authority to bypass those checks.
});

it('rechecks screen revocation without rebuilding the catalog', async () => {
  const routed = router();
  expect(await routed.execute({ action: 'call', name: 'procurement_tenders', args: '{"action":"list"}' })).toMatchObject({ success: true });
  blocked = ['procurementTenders'];
  expect(await routed.execute({ action: 'call', name: 'procurement_tenders', args: '{"action":"list"}' })).toMatchObject({ status: 403 });
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('preserves the shared admin exemption but never bypasses revoked effective access', async () => {
  role = 'admin'; blocked = screens.map(([, screen]) => screen);
  const routed = router();
  expect(await routed.execute({ action: 'list', category: 'commerce' })).toMatchObject({ count: 6 });
  effective = false;
  expect(await routed.execute({ action: 'list', category: 'commerce' })).toMatchObject({ count: 0 });
  expect(await routed.execute({ action: 'call', name: 'procurement_orders', args: '{"action":"list"}' })).toMatchObject({ status: 403 });
  expect(dispatch).not.toHaveBeenCalled();
});

it('does not mask or weaken the canonical SQL denial after screen authorization', async () => {
  dispatch.mockRejectedValue(new Error('Procurement manager access denied'));
  expect(await router().execute({ action: 'call', name: 'procurement_tenders', args: '{"action":"list"}' }))
    .toMatchObject({ success: false, error: 'Procurement manager access denied' });
  expect(dispatch).toHaveBeenCalledTimes(1);
});