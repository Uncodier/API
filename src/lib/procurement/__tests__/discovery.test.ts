import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { routeTools } from '@/app/api/agents/tools/router/assistantProtocol';
import { createProcurementTools } from '../tools';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: { generateEmbeddings: jest.fn().mockRejectedValue(new Error('offline')) } }));

const scope = { siteId: randomUUID(), userId: randomUUID() };
let effective = true;
beforeEach(() => {
  jest.clearAllMocks(); effective = true;
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(() => ({ abortSignal: async () => ({ data: effective, error: null }) }));
  (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
    const chain: any = {};
    for (const method of ['select', 'eq', 'abortSignal']) chain[method] = () => chain;
    chain.maybeSingle = async () => ({ data: { user_id: scope.userId }, error: null });
    return chain;
  });
});

it('registers definitions in the factory shared by MCP stdio, HTTP and assistant tools', () => {
  const root = path.resolve(__dirname, '../../..');
  const factory = readFileSync(path.join(root, 'app/api/robots/instance/assistant/utils.ts'), 'utf8');
  const mcp = readFileSync(path.join(root, 'lib/mcp/server.ts'), 'utf8');
  expect(factory).toContain('...createProcurementTools({ siteId, userId })');
  expect(mcp).toContain('getAssistantTools(siteId, userId, instanceId, customTools)');
});

it('discovers, describes and executes procurement through the same routed catalog as MCP', async () => {
  const dispatch = jest.fn().mockResolvedValue({ tenders: [], count: 0 });
  const routed = routeTools(createProcurementTools(scope, { rpc: dispatch }), scope);
  const router = routed.find(tool => tool.name === 'tools')!;
  const listed = await router.execute({ action: 'list', category: 'commerce' });
  expect(listed.tools.map((tool: any) => tool.name).sort()).toEqual(createProcurementTools(scope).map(tool => tool.name).sort());
  const described = await router.execute({ action: 'describe', name: 'procurement_tenders' });
  expect(JSON.stringify(described)).toContain('invitation_only');
  const result = await router.execute({ action: 'call', name: 'procurement_tenders', args: JSON.stringify({ action: 'list', limit: 5 }) });
  expect(result).toMatchObject({ success: true });
  expect(dispatch).toHaveBeenCalledWith('tenders.list', { limit: 5, offset: 0 });
  effective = false;
  expect(await router.execute({ action: 'list', category: 'commerce' })).toMatchObject({ count: 0 });
  expect(await router.execute({ action: 'call', name: 'procurement_tenders', args: '{"action":"list"}' })).toMatchObject({ status: 403 });
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('rejects cross-tenant and cross-actor overrides before procurement dispatch', async () => {
  const dispatch = jest.fn();
  const router = routeTools(createProcurementTools(scope, { rpc: dispatch }), scope).find(tool => tool.name === 'tools')!;
  for (const field of ['site_id', 'user_id']) {
    expect(await router.execute({ action: 'call', name: 'procurement_tenders', args: JSON.stringify({ action: 'list', [field]: randomUUID() }) })).toMatchObject({ status: 403 });
  }
  expect(dispatch).not.toHaveBeenCalled();
});