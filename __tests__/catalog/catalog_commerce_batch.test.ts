import { randomUUID } from 'node:crypto';
import { batchUpdateSchema } from '@/app/api/agents/tools/catalog_commerce/handlers/batch-schema';
import { handleBatchUpdate } from '@/app/api/agents/tools/catalog_commerce/handlers/batch';
import { catalogCommerceTool } from '@/app/api/agents/tools/catalog_commerce/assistantProtocol';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/agents/tools/catalog_commerce/route';
import { toolsRouterTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { bindCatalogBatchActor } from '@/app/api/agents/tools/catalog_commerce/batch-admin-tool';
import { enforceRequestRateLimit } from '@/lib/security/request-rate-limit';

jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: {} }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({
  ...jest.requireActual('@/app/api/agents/tools/router/screen-access'),
  loadToolScreenAccess: jest.fn().mockResolvedValue({ isAdmin: true, blockedScreens: [] }),
}));
jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: jest.fn().mockResolvedValue(null) }));

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/app/api/agents/tools/utils/fetch-helper', () => ({ fetchApiTool: jest.fn() }));

const site = randomUUID();
const owner = randomUUID();
const tax = randomUUID();
const location = randomUUID();
let ids: string[];
let calls: { table: string; method: string; args: any[] }[];
let failTable: string | undefined;
let existingTaxes: string[];
let siteOwner: string;
let membershipCount: number;
let membershipRole: string;

beforeEach(() => {
  jest.clearAllMocks();
  ids = Array.from({ length: 595 }, () => randomUUID());
  calls = []; failTable = undefined; existingTaxes = [];
  siteOwner = owner; membershipCount = 0;
  membershipRole = 'collaborator';
  (enforceRequestRateLimit as jest.Mock).mockResolvedValue(null);
  (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ data: true, error: null });
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    let range = [0, 999];
    let selected = ids;
    let write = false;
    const chain: any = {};
    for (const method of ['select', 'eq', 'in', 'order', 'range', 'update', 'insert', 'delete', 'upsert', 'maybeSingle']) {
      chain[method] = (...args: any[]) => {
        calls.push({ table, method, args });
        if (method === 'range') range = args;
        if (method === 'in' && args[0] === 'id') selected = args[1];
        if (['update', 'insert', 'delete', 'upsert'].includes(method)) write = true;
        return chain;
      };
    }
    chain.then = (resolve: any) => resolve({
      count: membershipCount,
      data: table === 'sites' ? { user_id: siteOwner }
        : table === 'site_members' ? Array.from({ length: membershipCount }, () => ({ id: randomUUID(), role: membershipRole }))
        : table === 'catalog_items' ? selected.slice(range[0], range[1] + 1).map(id => ({ id }))
        : table === 'taxes' ? [{ id: tax }]
        : table === 'locations' ? [{ id: location }]
        : table === 'catalog_item_taxes' ? existingTaxes.map(catalog_item_id => ({ catalog_item_id })) : [],
      error: write && table === failTable ? { message: 'write failed' } : null,
    });
    return chain;
  });
});

const input = (extra = {}) => batchUpdateSchema.parse({
  action: 'batch_update', site_id: site, all_items: true,
  taxes: { mode: 'add', tax_ids: [tax] }, ...extra,
});
const writes = () => calls.filter(call => ['insert', 'update', 'upsert', 'delete'].includes(call.method));

test('previews all 595 items without writes or price changes', async () => {
  const result = await (await handleBatchUpdate(input())).json();
  expect(result).toMatchObject({ success: true, dry_run: true, matched_count: 595, changes: {} });
  expect(result.item_ids).toEqual(ids);
  expect(writes()).toEqual([]);
});

test('adds tax in six batches without touching products or existing attachments', async () => {
  existingTaxes = [ids[0]];
  const result = await (await handleBatchUpdate(input({ dry_run: false, expected_count: 595 }))).json();
  expect(result.success).toBe(true);
  const inserted = writes().flatMap(call => call.args[0]);
  expect(writes()).toHaveLength(6);
  expect(inserted).toHaveLength(594);
  expect(inserted.every(row => row.tax_id === tax && row.site_id === site)).toBe(true);
  expect(writes().every(call => call.table === 'catalog_item_taxes')).toBe(true);
  expect(writes().every(call => call.method === 'upsert'
    && call.args[1].onConflict === 'catalog_item_id,tax_id' && call.args[1].ignoreDuplicates === true)).toBe(true);
});

test.each([
  { all_items: false }, { item_ids: [randomUUID()] },
  { changes: { quantity: 10 } }, { changes: { status: 'invalid' } },
  { inventory: { location_id: location, quantity: -1 } },
  { dry_run: false }, { taxes: undefined, changes: {} },
])('rejects unsafe or invalid input %j', extra => {
  expect(() => input(extra)).toThrow();
});

test('count mismatch prevents every write', async () => {
  const response = await handleBatchUpdate(input({ dry_run: false, expected_count: 594 }));
  expect(response.status).toBe(409);
  expect(writes()).toEqual([]);
});

test('foreign tax and location references prevent all writes', async () => {
  await expect(handleBatchUpdate(input({ taxes: { mode: 'add', tax_ids: [randomUUID()] } })))
    .rejects.toThrow('foreign-site taxes');
  await expect(handleBatchUpdate(input({ inventory: { location_id: randomUUID(), quantity: 0 } })))
    .rejects.toThrow('foreign-site locations');
  expect(writes()).toEqual([]);
});

test('rejects catalogs exceeding the cap rather than truncating', async () => {
  ids = Array.from({ length: 1100 }, () => randomUUID());
  expect((await handleBatchUpdate(input())).status).toBe(400);
  expect(writes()).toEqual([]);
});

test('sets zero stock at one location and preserves false channel flags', async () => {
  const result = await (await handleBatchUpdate(input({
    taxes: undefined, changes: { is_pos_available: false },
    inventory: { location_id: location, quantity: 0 }, dry_run: false, expected_count: 595,
  }))).json();
  expect(result.success).toBe(true);
  expect(writes().find(call => call.method === 'update')?.args[0]).toMatchObject({ is_pos_available: false });
  const stock = writes().filter(call => call.method === 'upsert');
  expect(stock.flatMap(call => call.args[0])).toHaveLength(595);
  expect(stock[0].args[0][0]).toMatchObject({ quantity: 0, location_id: location, site_id: site });
});

test('reports completed and uncertain operations without claiming rollback', async () => {
  failTable = 'catalog_item_taxes';
  const response = await handleBatchUpdate(input({ changes: { status: 'active' }, dry_run: false, expected_count: 595 }));
  const result = await response.json();
  expect(response.status).toBe(500);
  expect(result).toMatchObject({ success: false, atomic: false, uncertain_operation: { operation: `taxes_add:${tax}` } });
  expect(result.completed).toHaveLength(1);
  expect(result.completed[0].operation).toBe('changes');
});

test('administrative tool binds actor and site and defaults to preview', async () => {
  const tool = bindCatalogBatchActor(catalogCommerceTool(site), { siteId: site, userId: owner });
  expect(tool.parameters.properties.action.enum).toContain('batch_update');
  expect(await tool.execute({ action: 'batch_update', all_items: true, changes: { status: 'archived' }, thought_process: 'Review selection' }))
    .toMatchObject({ success: true, dry_run: true });
  expect(fetchApiTool).not.toHaveBeenCalled();
  expect(await tool.execute({ action: 'batch_update', site_id: randomUUID(), all_items: true })).toMatchObject({ success: false });
});

test('route denies unverified callers before querying or modifying data', async () => {
  const response = await POST(new NextRequest('https://api.example.test/api/agents/tools/catalog_commerce', {
    method: 'POST', body: JSON.stringify(input()),
  }));
  expect(response.status).toBe(403);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

test('HTTP batch cannot bypass actor authorization using body identity', async () => {
  const request = (body: unknown) => new NextRequest('https://api.example.test/api/agents/tools/catalog_commerce', {
    method: 'POST', body: JSON.stringify(body),
  });
  const response = await POST(request({ ...input(), user_id: owner }));
  expect(response.status).toBe(403);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(writes()).toEqual([]);
});

test('unscoped tools used by customer support and voice neither advertise nor execute batch', async () => {
  const tool = catalogCommerceTool(site);
  expect(tool.parameters.properties.action.enum).not.toContain('batch_update');
  expect(tool.parameters.properties).not.toHaveProperty('inventory');
  await expect(tool.execute(input())).rejects.toThrow('administrative router');
  expect(fetchApiTool).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

test.each(['non-owner', 'revoked', 'ambiguous-membership', 'actor-spoof'])('fails closed for %s before catalog access', async reason => {
  if (reason === 'non-owner') siteOwner = randomUUID();
  if (reason === 'revoked') (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ data: false, error: null });
  if (reason === 'ambiguous-membership') membershipCount = 2;
  const tool = bindCatalogBatchActor(catalogCommerceTool(site), { siteId: site, userId: owner });
  const result = await tool.execute({ ...input(), ...(reason === 'actor-spoof' ? { user_id: owner } : {}) });
  expect(result.success).toBe(false);
  expect(calls.some(call => call.table === 'catalog_items')).toBe(false);
});

test('partial failure survives the complete administrative router boundary', async () => {
  failTable = 'catalog_item_taxes';
  const router = toolsRouterTool([catalogCommerceTool(site)], { siteId: site, userId: owner });
  const result = await router.execute({ action: 'call', name: 'catalog_commerce', args: JSON.stringify(input({
    changes: { status: 'active' }, dry_run: false, expected_count: 595,
  })) });
  expect(result.success).toBe(false);
  expect('result' in result ? result.result : undefined).toMatchObject({ success: false, atomic: false,
    completed: [{ operation: 'changes', item_ids: ids.slice(0, 100) }],
    uncertain_operation: { operation: `taxes_add:${tax}`, item_ids: ids.slice(0, 100) },
  });
});

test('rate limit denial prevents batch reads and writes', async () => {
  (enforceRequestRateLimit as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'Too many requests' }), { status: 429 }));
  const tool = bindCatalogBatchActor(catalogCommerceTool(site), { siteId: site, userId: owner });
  expect(await tool.execute(input())).toMatchObject({ success: false });
  expect(calls.some(call => call.table === 'catalog_items')).toBe(false);
});

test('effective access lookup failure denies even the site owner', async () => {
  (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ data: true, error: { message: 'unavailable' } });
  const tool = bindCatalogBatchActor(catalogCommerceTool(site), { siteId: site, userId: owner });
  expect(await tool.execute(input())).toMatchObject({ success: false });
  expect(calls.some(call => call.table === 'catalog_items')).toBe(false);
});

test.each(['owner', 'admin'])('active licensed member with role %s can preview and execute inventory/taxes', async role => {
  siteOwner = randomUUID(); membershipCount = 1; membershipRole = role;
  const tool = bindCatalogBatchActor(catalogCommerceTool(site), { siteId: site, userId: owner });
  expect(await tool.execute(input())).toMatchObject({ success: true, dry_run: true });
  expect(writes()).toEqual([]);
  expect(await tool.execute(input({ dry_run: false, expected_count: 595,
    inventory: { location_id: location, quantity: 0 },
  }))).toMatchObject({ success: true, dry_run: false });
  expect(calls).toContainEqual({ table: 'site_members', method: 'eq', args: ['status', 'active'] });
  expect(calls).toContainEqual({ table: 'site_members', method: 'eq', args: ['site_id', site] });
  expect(calls).toContainEqual({ table: 'site_members', method: 'eq', args: ['user_id', owner] });
});

test.each(['collaborator', 'marketing', 'viewer', 'unknown'])('non-manager role %s remains denied', async role => {
  siteOwner = randomUUID(); membershipCount = 1; membershipRole = role;
  const tool = bindCatalogBatchActor(catalogCommerceTool(site), { siteId: site, userId: owner });
  expect(await tool.execute(input())).toMatchObject({ success: false });
  expect(calls.some(call => call.table === 'catalog_items')).toBe(false);
});

test.each(['revoked', 'duplicate', 'inactive'])('admin with %s access remains denied', async reason => {
  siteOwner = randomUUID(); membershipCount = 1; membershipRole = 'admin';
  if (reason === 'revoked') (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ data: false, error: null });
  if (reason === 'duplicate') membershipCount = 2;
  if (reason === 'inactive') membershipCount = 0;
  const tool = bindCatalogBatchActor(catalogCommerceTool(site), { siteId: site, userId: owner });
  expect(await tool.execute(input())).toMatchObject({ success: false });
  expect(calls.some(call => call.table === 'catalog_items')).toBe(false);
});