import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EmbeddingsService } from '@/lib/services/embeddings-service';
import { routeTools, toolsRouterTool, withToolsRouter, type RoutedTool } from '../assistantProtocol';
import { canUseToolScreen, guardFinalToolCatalog, loadToolScreenAccess } from '../screen-access';
import mapping from '../tool-screen-map.json';
import { purchasesTool } from '../../purchases/assistantProtocol';
import { purchaseItemsTool } from '../../purchase_items/assistantProtocol';
import { tasksTool } from '../../tasks/assistantProtocol';
import { getTaskCore } from '../../tasks/get/core';
import { fetchApiTool } from '../../utils/fetch-helper';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: { generateEmbeddings: jest.fn() } }));
jest.mock('../../utils/fetch-helper', () => ({ fetchApiTool: jest.fn() }));
jest.mock('../../tasks/get/core', () => ({ getTaskCore: jest.fn() }));

const scope = { siteId: randomUUID(), userId: randomUUID() };
const otherUser = randomUUID();
let role: string;
let blocked: unknown;
let owner: string;
let ownership: boolean;
let member: boolean;
let effective: boolean;
let failTable: string | undefined;

function tool(name: string) {
  return { name, description: `Private ${name} schema`,
    parameters: { type: 'object', properties: { action: { type: 'string' } } },
    execute: jest.fn(async (..._args: any[]) => 'executed') };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  role = 'collaborator'; blocked = []; owner = otherUser; ownership = false;
  member = true; effective = true; failTable = undefined;
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(() => ({ abortSignal: async () => ({ data: effective, error: null }) }));
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const query: any = {};
    for (const name of ['select', 'eq', 'abortSignal']) query[name] = jest.fn(() => query);
    query.maybeSingle = async () => ({
      data: table === 'sites' ? { user_id: owner } : table === 'site_ownership'
        ? ownership ? { site_id: scope.siteId } : null : member ? { role, blocked_screens: blocked } : null,
      error: failTable === table ? { message: 'lookup failed' } : null,
    });
    return query;
  });
  (EmbeddingsService.generateEmbeddings as jest.Mock).mockRejectedValue(new Error('offline'));
});

it('maps actual assistant protocol names and never grants access to unknown names/prefixes', () => {
  const root = path.resolve('src/app/api/agents/tools');
  const files = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'router');
  for (const directory of files) {
    let source: string;
    try { source = readFileSync(path.join(root, directory.name, 'assistantProtocol.ts'), 'utf8'); }
    catch { continue; }
    for (const match of source.matchAll(/name:\s*['"]([\w]+)['"]/g)) {
      expect(mapping.tools).toHaveProperty(match[1]);
    }
  }
  for (const name of ['new_tool', 'sandbox_new', 'qa_new', '__proto__', 'constructor']) {
    expect(canUseToolScreen(name, { isAdmin: true, blockedScreens: [] })).toBe(false);
  }
});

it('uses exact navigation keys and all required screens, not category or role strings', () => {
  expect(canUseToolScreen('transactions', { isAdmin: false, blockedScreens: ['transactions'] })).toBe(false);
  expect(canUseToolScreen('sales', { isAdmin: false, blockedScreens: ['transactions'] })).toBe(true);
  expect(canUseToolScreen('publish', { isAdmin: false, blockedScreens: ['social'] })).toBe(false);
  expect(canUseToolScreen('webSearch', null)).toBe(true);
});

it('allows an editor to discover and create CRM tasks when AI Activities is blocked', async () => {
  blocked = ['activities', 'requirements', 'agentsConfiguration'];
  expect(mapping.tools.tasks.screens).toEqual(['controlCenter']);
  const router = toolsRouterTool([tasksTool(scope.siteId, scope.userId)], scope);
  expect(await router.execute({ action: 'list' })).toMatchObject({ count: 1, tools: [{ name: 'tasks' }] });
  expect(await router.execute({ action: 'search', query: 'tasks' })).toMatchObject({ count: 1, tools: [{ name: 'tasks' }] });
  expect(await router.execute({ action: 'describe', name: 'tasks' })).toMatchObject({ success: true, name: 'tasks' });

  const params = { title: 'Follow-up call', type: 'call', lead_id: randomUUID(), assignee: scope.userId };
  const task = { id: randomUUID(), ...params };
  (fetchApiTool as jest.Mock).mockResolvedValue({ success: true, task });
  expect(await router.execute({ action: 'call', name: 'tasks', args: JSON.stringify({ action: 'create', ...params }) }))
    .toMatchObject({ success: true, result: { success: true, task } });
  expect(fetchApiTool).toHaveBeenCalledWith('/api/agents/tools/tasks/create', {
    ...params, site_id: scope.siteId, user_id: scope.userId,
  }, 'Create task failed');

  blocked = ['controlCenter'];
  expect(await router.execute({ action: 'call', name: 'tasks', args: { action: 'create', ...params } }))
    .toMatchObject({ success: false, code: 'TOOL_SCREEN_ACCESS_DENIED', status: 403 });
  expect(fetchApiTool).toHaveBeenCalledTimes(1);
});

it('blocks CRM task discovery and every action when Tasks is blocked, even with AI Activities allowed', async () => {
  blocked = ['controlCenter'];
  const definition = tasksTool(scope.siteId, scope.userId);
  const router = toolsRouterTool([definition], scope);
  expect(await router.execute({ action: 'list' })).toMatchObject({ count: 0 });
  expect(await router.execute({ action: 'search', query: 'tasks' })).toMatchObject({ count: 0 });
  const described = await router.execute({ action: 'describe', name: 'tasks' });
  expect(described).toMatchObject({ success: false, code: 'TOOL_SCREEN_ACCESS_DENIED', status: 403 });
  expect(described).not.toHaveProperty('parameters');

  const guarded = guardFinalToolCatalog([definition], scope)[0];
  for (const action of ['create', 'list', 'update'] as const) {
    const args = { action, title: 'Follow-up call', type: 'call', lead_id: randomUUID(), task_id: randomUUID() };
    expect(await router.execute({ action: 'call', name: 'tasks', args }))
      .toMatchObject({ success: false, code: 'TOOL_SCREEN_ACCESS_DENIED', status: 403 });
    await expect(guarded.execute(args)).rejects.toMatchObject({ code: 'TOOL_SCREEN_ACCESS_DENIED', status: 403 });
  }
  expect(fetchApiTool).not.toHaveBeenCalled();
  expect(getTaskCore).not.toHaveBeenCalled();
});

it('hides denied tools in list, keyword search and describe without exposing schemas', async () => {
  blocked = ['transactions'];
  const transactions = tool('transactions'); const sales = tool('sales');
  const router = toolsRouterTool([transactions, sales, tool('unmapped')], scope);
  expect(await router.execute({ action: 'list' })).toMatchObject({ count: 1, tools: [{ name: 'sales' }] });
  expect(await router.execute({ action: 'search', query: 'transactions sales' })).toMatchObject({ count: 1, tools: [{ name: 'sales' }] });
  const described = await router.execute({ action: 'describe', name: 'transactions' });
  expect(described).toMatchObject({ success: false, status: 403, code: 'TOOL_SCREEN_ACCESS_DENIED' });
  expect(described).not.toHaveProperty('parameters');
  expect(transactions.execute).not.toHaveBeenCalled();
});

it('filters semantic search too', async () => {
  blocked = ['transactions'];
  (EmbeddingsService.generateEmbeddings as jest.Mock).mockResolvedValue({ embeddings: [[1, 0], [1, 0]] });
  const embeddings = EmbeddingsService as any;
  embeddings.cosineSimilarity = jest.fn(() => 1);
  const result = await toolsRouterTool([tool('transactions'), tool('sales')], scope)
    .execute({ action: 'search', query: 'financial information' });
  expect(result).toMatchObject({ count: 1, tools: [{ name: 'sales' }] });
});

it('denies execution before parsing or side effects, ignores spoofed model identity and applies revocation', async () => {
  const transactions = tool('transactions');
  const router = toolsRouterTool([transactions], scope);
  expect(await router.execute({ action: 'call', name: 'transactions', args: '{}' })).toMatchObject({ success: true });
  blocked = ['transactions'];
  expect(await router.execute({ action: 'call', name: 'transactions', args: '{invalid' }))
    .toMatchObject({ code: 'TOOL_SCREEN_ACCESS_DENIED' });
  expect(await router.execute({ action: 'call', name: 'transactions', args: JSON.stringify({ user_id: owner, role: 'admin', blocked_screens: [] }) }))
    .toMatchObject({ status: 403 });
  expect(transactions.execute).toHaveBeenCalledTimes(1);
  expect(supabaseAdmin.rpc).toHaveBeenCalledWith('site_user_has_effective_access', { p_site_id: scope.siteId, p_user_id: scope.userId });
});

it.each(['owner', 'admin', 'ownership'])('honors %s exemption only with current effective site access', async kind => {
  blocked = ['transactions'];
  if (kind === 'owner') owner = scope.userId;
  if (kind === 'admin') role = 'admin';
  if (kind === 'ownership') ownership = true;
  const transactions = tool('transactions');
  const router = toolsRouterTool([transactions], scope);
  expect(await router.execute({ action: 'call', name: 'transactions' })).toMatchObject({ success: true });
  effective = false;
  expect(await router.execute({ action: 'call', name: 'transactions' })).toMatchObject({ status: 403 });
  expect(transactions.execute).toHaveBeenCalledTimes(1);
});

it.each(['sites', 'site_ownership', 'site_members'])('fails closed on %s query error', async table => {
  failTable = table;
  await expect(loadToolScreenAccess(scope)).rejects.toMatchObject({
    code: 'TOOL_SCREEN_ACCESS_UNAVAILABLE', status: 503, recoverable: true,
  });
});

it('fails closed for missing membership, malformed data or missing scope; legacy null is unrestricted', async () => {
  member = false;
  expect(await loadToolScreenAccess(scope)).toBeNull();
  member = true; blocked = 'transactions';
  expect(await loadToolScreenAccess(scope)).toBeNull();
  blocked = null;
  expect(await loadToolScreenAccess(scope)).toEqual({ isAdmin: false, blockedScreens: [] });
  expect(await loadToolScreenAccess()).toBeNull();
  expect(await loadToolScreenAccess({ siteId: scope.siteId })).toBeNull();
  expect(await loadToolScreenAccess({ siteId: 'invalid', userId: scope.userId })).toBeNull();
  expect(await toolsRouterTool([tool('transactions')]).execute({ action: 'call', name: 'transactions' })).toMatchObject({ status: 403 });
});

it('protects directly exposed tools in both partition helpers and does not trust prefixes', async () => {
  blocked = ['requirements'];
  const requirement = tool('requirements');
  const unknown = tool('sandbox_unknown');
  for (const definitions of [routeTools([requirement, unknown], scope), withToolsRouter([requirement], new Set(['requirements']), scope)]) {
    await expect(definitions.find(t => t.name === 'requirements')!.execute({ role: 'admin' }))
      .rejects.toMatchObject({ status: 403, code: 'TOOL_SCREEN_ACCESS_DENIED' });
  }
  await expect(routeTools([unknown], scope)[0].execute({})).rejects.toMatchObject({ status: 403 });
  expect(requirement.execute).not.toHaveBeenCalled(); expect(unknown.execute).not.toHaveBeenCalled();
});

it('blocks generic privileged proxies and executable diagnostics for nonadmins even if no screen is blocked', () => {
  for (const name of ['site_settings', 'use_composio_tools', 'integration_api_request', 'webhooks', 'sandbox_run_command',
    'sandbox_read_lints', 'sandbox_run_tests', 'sandbox_run_validation']) {
    expect(canUseToolScreen(name, { isAdmin: false, blockedScreens: [] })).toBe(false);
  }
});

it('blocks the actual bills tools for denied users, including payment and line changes', async () => {
  blocked = ['bills', 'transactions'];
  const router = toolsRouterTool([purchasesTool(scope.siteId), purchaseItemsTool(scope.siteId)], scope);
  expect(await router.execute({ action: 'list' })).toMatchObject({ count: 0 });
  for (const action of ['list', 'get', 'create', 'update', 'delete', 'register_payment']) {
    expect(await router.execute({ action: 'call', name: 'purchases', args: JSON.stringify({ action, id: otherUser, title: 'Bill', amount: 10, method: 'cash' }) }))
      .toMatchObject({ status: 403, code: 'TOOL_SCREEN_ACCESS_DENIED' });
  }
  expect(await router.execute({ action: 'call', name: 'purchase_items', args: { action: 'list', purchase_id: otherUser } }))
    .toMatchObject({ status: 403 });
  expect(fetchApiTool).not.toHaveBeenCalled();
});

it('uses bills rather than purchase-order navigation for allowed supplier bills and exempts admins', async () => {
  blocked = ['purchasesOrders'];
  (fetchApiTool as jest.Mock).mockResolvedValue({ success: true });
  const router = toolsRouterTool([purchasesTool(scope.siteId)], scope);
  expect(await router.execute({ action: 'call', name: 'purchases', args: { action: 'list' } })).toMatchObject({ success: true });
  expect(fetchApiTool).toHaveBeenCalledWith('/api/agents/tools/purchases', { action: 'list', site_id: scope.siteId }, expect.any(String));
  role = 'admin'; blocked = ['bills'];
  expect(await router.execute({ action: 'call', name: 'purchases', args: { action: 'register_payment', id: otherUser, amount: 10, method: 'cash' } }))
    .toMatchObject({ success: true });
});

it('binds requirements creator only on create, preserving the legitimate list filter', async () => {
  const requirement = tool('requirements');
  const guarded = routeTools([requirement], scope)[0];
  await expect(guarded.execute({ action: 'create', user_id: otherUser })).rejects.toMatchObject({ status: 403 });
  expect(requirement.execute).not.toHaveBeenCalled();
  await guarded.execute({ action: 'list', user_id: otherUser });
  expect(requirement.execute).toHaveBeenCalledWith({ action: 'list', user_id: otherUser });
});

it('does not expose chat/context data through report or system notifications when those screens are blocked', async () => {
  for (const screen of ['chat', 'context', 'activities', 'requirements', 'segments']) {
    blocked = [screen];
    const report = tool('report');
    const output = await toolsRouterTool([report], scope).execute({ action: 'call', name: 'report', args: '{"table":"messages"}' });
    expect(output).toMatchObject({ status: 403 });
    expect(report.execute).not.toHaveBeenCalled();
  }
  blocked = ['chat'];
  expect(await toolsRouterTool([tool('system_notification')], scope).execute({ action: 'describe', name: 'system_notification' }))
    .toMatchObject({ status: 403 });
});

it('rejects explicit tenant overrides, including for admins, and locks actor fields where authoritative', async () => {
  role = 'admin';
  for (const name of ['leads', 'instance', 'transactions']) {
    const definition = tool(name);
    const result = await toolsRouterTool([definition], scope).execute({ action: 'call', name,
      args: JSON.stringify({ site_id: randomUUID() }) });
    expect(result).toMatchObject({ status: 403 });
    expect(definition.execute).not.toHaveBeenCalled();
  }
  const instance = tool('instance');
  expect(await toolsRouterTool([instance], scope).execute({ action: 'call', name: 'instance', args: { user_id: owner } }))
    .toMatchObject({ status: 403 });
  expect(instance.execute).not.toHaveBeenCalled();
});

it('does not confuse legitimate user filters with actor authority', async () => {
  const leads = tool('leads');
  expect(await toolsRouterTool([leads], scope).execute({ action: 'call', name: 'leads', args: { site_id: scope.siteId, user_id: otherUser } }))
    .toMatchObject({ success: true });
  expect(leads.execute).toHaveBeenCalledWith({ site_id: scope.siteId, user_id: otherUser });
});

it('captures scope independently of later host-object mutation and model metadata', async () => {
  const mutableScope: { siteId: string; userId: string } = { ...scope };
  const router = toolsRouterTool([tool('transactions')], mutableScope);
  mutableScope.userId = owner;
  blocked = ['transactions'];
  expect(await router.execute({ action: 'call', name: 'transactions', args: { userId: owner } })).toMatchObject({ status: 403 });
  expect(supabaseAdmin.rpc).toHaveBeenCalledWith('site_user_has_effective_access', { p_site_id: scope.siteId, p_user_id: scope.userId });
});

it('does not execute protected tools on thrown database errors, and unknown tools remain denied for admins', async () => {
  const transactions = tool('transactions');
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(() => { throw new Error('unavailable'); });
  expect(await toolsRouterTool([transactions], scope).execute({ action: 'call', name: 'transactions' })).toMatchObject({
    status: 503, recoverable: true, executed: false, error: { effectStarted: false },
  });
  expect(transactions.execute).not.toHaveBeenCalled();
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(() => ({ abortSignal: async () => ({ data: true, error: null }) }));
  role = 'admin';
  const unknown = tool('new_tool');
  expect(await toolsRouterTool([unknown], scope).execute({ action: 'call', name: unknown.name })).toMatchObject({ status: 403 });
  expect(unknown.execute).not.toHaveBeenCalled();
});

it('guards late repair tools and short-circuit replacements in the final catalog without granting routers an exemption', async () => {
  const history = tool('instance_history');
  const tests = tool('sandbox_run_tests');
  const validation = tool('sandbox_run_validation');
  const originalPlan = tool('instance_plan');
  const [plan] = routeTools([originalPlan], scope);
  const noop = jest.fn(async () => ({ success: true, noop: true }));
  const router = toolsRouterTool([tool('transactions')], scope);
  // Simulate host helpers replacing an already guarded execute and adding tools.
  const final = guardFinalToolCatalog<RoutedTool>([history, tests, validation, { ...plan, execute: noop }, router], scope);
  blocked = ['requirements', 'transactions'];
  for (const name of ['instance_history', 'instance_plan']) {
    await expect(final.find(t => t.name === name)!.execute({ action: 'execute_step' })).rejects.toMatchObject({ status: 403 });
  }
  expect(history.execute).not.toHaveBeenCalled(); expect(noop).not.toHaveBeenCalled();
  for (const name of ['sandbox_run_tests', 'sandbox_run_validation']) {
    await expect(final.find(t => t.name === name)!.execute({})).rejects.toMatchObject({ status: 403 });
  }
  expect(tests.execute).not.toHaveBeenCalled(); expect(validation.execute).not.toHaveBeenCalled();
  expect(await final.find(t => t.name === 'tools')!.execute({ action: 'call', name: 'transactions' })).toMatchObject({ status: 403 });
  role = 'admin';
  await final.find(t => t.name === 'sandbox_run_validation')!.execute({});
  expect(validation.execute).toHaveBeenCalledTimes(1);
});

afterEach(() => jest.restoreAllMocks());