import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { priceListBatchSchema } from '@/app/api/agents/tools/price_lists/batch-schema';
import { handlePriceListBatch } from '@/app/api/agents/tools/price_lists/batch';
import * as batchHandler from '@/app/api/agents/tools/price_lists/batch';
import { priceListsTool } from '@/app/api/agents/tools/price_lists/assistantProtocol';
import { bindCatalogBatchActor } from '@/app/api/agents/tools/catalog_commerce/batch-admin-tool';
import { toolsRouterTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { POST } from '@/app/api/agents/tools/price_lists/route';
import { supabaseAdmin as db } from '@/lib/database/supabase-client';
import { enforceRequestRateLimit } from '@/lib/security/request-rate-limit';
import { authorizeCatalogRequest, CatalogAuthorizationError } from '@/lib/services/catalog-search/auth';
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: jest.fn() }));
jest.mock('@/app/api/agents/tools/utils/fetch-helper', () => ({ fetchApiTool: jest.fn() }));
jest.mock('@/lib/services/catalog-search/auth', () => ({
  authorizeCatalogRequest: jest.fn(),
  CatalogAuthorizationError: class extends Error { constructor(public status: number) { super('Denied'); } },
}));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: {} }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({
  ...jest.requireActual('@/app/api/agents/tools/router/screen-access'),
  loadToolScreenAccess: jest.fn().mockResolvedValue({ isAdmin: true, blockedScreens: [] }),
}));

const site = randomUUID(), user = randomUUID(), listId = randomUUID(), itemId = randomUUID();
let calls: { table: string; method: string; args: any[] }[];
let missingTable: string | undefined, failedWrite: string | undefined, foreignItem: boolean;
let owner: string, role: string, members: number;
beforeEach(() => {
  jest.clearAllMocks();
  calls = []; missingTable = undefined; failedWrite = undefined; foreignItem = false;
  owner = user; role = 'admin'; members = 0;
  (db.rpc as jest.Mock).mockResolvedValue({ data: true, error: null });
  (enforceRequestRateLimit as jest.Mock).mockResolvedValue(null);
  (authorizeCatalogRequest as jest.Mock).mockResolvedValue({});
  (db.from as jest.Mock).mockImplementation((table: string) => {
    let ids: string[] = [], inserted: any[] = [], write = false;
    const chain: any = {};
    for (const method of ['select', 'eq', 'in', 'order', 'range', 'update', 'insert', 'delete', 'upsert', 'single', 'maybeSingle']) {
      chain[method] = (...args: any[]) => {
        calls.push({ table, method, args });
        if (method === 'in' && args[0] === 'id') ids = args[1];
        if (method === 'insert') inserted = args[0];
        if (['update', 'insert', 'delete', 'upsert'].includes(method)) write = true;
        return chain;
      };
    }
    chain.then = (resolve: any) => resolve({
      data: table === missingTable ? [] : table === 'sites' ? { user_id: owner }
        : table === 'site_members' ? Array.from({ length: members }, () => ({ id: randomUUID(), role }))
        : table === 'price_list_items' ? (foreignItem ? [{ site_id: randomUUID() }] : [])
        : (inserted.length ? inserted : ids.map(id => ({ id }))),
      count: members, error: write && table === failedWrite ? { message: 'sensitive database detail' } : null,
    });
    return chain;
  });
});
const parse = (extra = {}) => priceListBatchSchema.parse({ action: 'batch_update', site_id: site,
  price_list_ids: [listId], changes: { is_active: false }, ...extra });
const create = (extra = {}) => priceListBatchSchema.parse({ action: 'batch_create', site_id: site,
  lists: [{ name: 'Wholesale', currency: 'USD', items: [{ catalog_item_id: itemId, unit_price: 12 }] }], ...extra });
const writes = () => calls.filter(call => ['insert', 'update', 'upsert', 'delete'].includes(call.method));
const tool = () => bindCatalogBatchActor(priceListsTool(site), { siteId: site, userId: user });
const request = (body: unknown) => new NextRequest('https://api.example.test/api/agents/tools/price_lists', {
  method: 'POST', body: JSON.stringify(body),
});

test.each([
  { price_list_ids: [] }, { price_list_ids: [listId, listId] }, { price_list_ids: Array.from({ length: 1001 }, () => randomUUID()) },
  { changes: {} }, { changes: { user_id: user } }, { user_id: user }, { site_id: 'bad' },
  { dry_run: false }, { changes: { is_default: true } }, { changes: { currency: 'usd' } },
  { changes: { channels: [] } }, { changes: { channels: ['pos', 'pos'] } },
  { items: { set: [{ catalog_item_id: itemId, unit_price: -1 }] } },
  { items: { set: [{ catalog_item_id: itemId, unit_price: Infinity }] } },
  { items: { set: [{ catalog_item_id: itemId, unit_price: 1 }], remove: [itemId] } },
  { updates: [{ id: listId, changes: { is_active: true } }] },
])('rejects invalid update %j', extra => expect(() => parse(extra)).toThrow());

test('creation rejects foreign fields, duplicates, oversized item expansion and empty names', () => {
  for (const row of [{ name: '' }, { site_id: site }, { id: listId }, { is_default: true }]) {
    expect(() => create({ lists: [{ name: 'List', currency: 'USD', ...row }] })).toThrow();
  }
  expect(() => create({ lists: [{ name: 'List', currency: 'USD', items: [
    { catalog_item_id: itemId, unit_price: 1 }, { catalog_item_id: itemId, unit_price: 2 },
  ] }] })).toThrow();
  expect(() => parse({ price_list_ids: [listId, randomUUID()], items: { set: Array.from({ length: 501 }, () => ({
    catalog_item_id: randomUUID(), unit_price: 0,
  })) } })).toThrow();
});

test.each(['create', 'update'])('%s previews do not write and default dry_run=true', async action => {
  const result = await (await handlePriceListBatch(action === 'create' ? create() : parse())).json();
  expect(result).toMatchObject({ success: true, dry_run: true, matched_count: 1 });
  expect(writes()).toEqual([]);
});

test('creation writes bounded chunks, returns index/ID mapping and preserves catalog base prices', async () => {
  const lists = Array.from({ length: 101 }, (_, index) => ({ name: `List ${index}`, currency: 'USD' }));
  const result = await (await handlePriceListBatch(create({ lists, dry_run: false, expected_count: 101 }))).json();
  expect(result).toMatchObject({ success: true, atomic: false, matched_count: 101 });
  expect(result.created).toHaveLength(101);
  expect(result.created[0]).toEqual({ index: 0, id: expect.any(String) });
  expect(writes().map(call => call.args[0].length)).toEqual([100, 1]);
  expect(writes()[0].args[0][0]).toMatchObject({ site_id: site, channels: ['pos'], is_default: false });
  expect(writes().every(call => call.table === 'price_lists')).toBe(true);
});

test('sets heterogeneous prices and removes only explicitly selected overrides', async () => {
  const second = randomUUID(), removed = randomUUID();
  const input = parse({ price_list_ids: undefined, changes: undefined, updates: [
    { id: listId, items: { set: [{ catalog_item_id: itemId, unit_price: 0 }], remove: [removed] } },
    { id: second, changes: { name: 'Second' }, items: { set: [{ catalog_item_id: itemId, unit_price: 18 }] } },
  ], dry_run: false, expected_count: 2 });
  expect(await (await handlePriceListBatch(input)).json()).toMatchObject({ success: true });
  const sets = writes().filter(call => call.method === 'upsert');
  expect(sets.map(call => call.args[0][0].unit_price)).toEqual([0, 18]);
  expect(sets[0].args[1]).toEqual({ onConflict: 'price_list_id,catalog_item_id' });
  expect(sets[0].args[0][0]).toMatchObject({ site_id: site, price_list_id: listId, catalog_item_id: itemId });
  expect(calls).toContainEqual({ table: 'price_list_items', method: 'in', args: ['catalog_item_id', [removed]] });
  expect(writes().some(call => call.table === 'catalog_items')).toBe(false);
});

test('common updates and reference reads are bounded to 100', async () => {
  await handlePriceListBatch(parse({ price_list_ids: Array.from({ length: 201 }, () => randomUUID()), dry_run: false, expected_count: 201 }));
  expect(writes()).toHaveLength(3);
  expect(calls.filter(call => call.method === 'in').every(call => call.args[1].length <= 100)).toBe(true);
  expect(calls).toContainEqual({ table: 'price_lists', method: 'eq', args: ['site_id', site] });
});

test.each(['price_lists', 'catalog_items', 'legacy-tenant'])('preflight rejects %s references before writes', async table => {
  if (table === 'legacy-tenant') foreignItem = true; else missingTable = table;
  const response = await handlePriceListBatch(parse({ items: { set: [{ catalog_item_id: itemId, unit_price: 1 }] }, dry_run: false, expected_count: 1 }));
  expect(response.status).toBe(400);
  expect(writes()).toEqual([]);
});

test('mismatched expected_count returns conflict without writes', async () => {
  expect((await handlePriceListBatch(parse({ expected_count: 2, dry_run: false }))).status).toBe(409);
  expect(writes()).toEqual([]);
});

test('creation reports partial success and uncertain operation without leaking database details', async () => {
  failedWrite = 'price_list_items';
  const response = await handlePriceListBatch(create({ dry_run: false, expected_count: 1 }));
  const result = await response.json();
  expect(response.status).toBe(500);
  expect(result).toMatchObject({ success: false, atomic: false,
    completed: [{ operation: 'lists_create' }], uncertain_operation: { operation: 'items_set' } });
  expect(result.created).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('sensitive database detail');
});

test.each(['owner', 'admin'])('licensed %s membership can create and update', async memberRole => {
  owner = randomUUID(); members = 1; role = memberRole;
  expect(await tool().execute(create())).toMatchObject({ success: true });
  expect(await tool().execute(parse({ dry_run: false, expected_count: 1 }))).toMatchObject({ success: true });
});

test.each(['foreign-site', 'forged-user', 'duplicate', 'viewer', 'revoked', 'outage', 'missing-user', 'inactive'])('denies %s actors', async reason => {
  let input: any = parse();
  if (reason === 'foreign-site') input.site_id = randomUUID();
  if (reason === 'forged-user') input.user_id = randomUUID();
  if (reason === 'duplicate') members = 2;
  if (reason === 'viewer') { owner = randomUUID(); members = 1; role = 'viewer'; }
  if (reason === 'inactive') owner = randomUUID();
  if (reason === 'revoked') (db.rpc as jest.Mock).mockResolvedValue({ data: false, error: null });
  if (reason === 'outage') (db.rpc as jest.Mock).mockResolvedValue({ data: true, error: { message: 'failure' } });
  if (reason === 'missing-user') {
    const unbound = bindCatalogBatchActor(priceListsTool(site), { siteId: site });
    await expect(unbound.execute(input)).rejects.toThrow('administrative router');
  } else expect(await tool().execute(input)).toMatchObject({ success: false });
  expect(calls.some(call => call.table === 'price_lists')).toBe(false);
  expect(fetchApiTool).not.toHaveBeenCalled();
});

test('rate-limit denial prevents all list reads and writes', async () => {
  (enforceRequestRateLimit as jest.Mock).mockResolvedValue(Response.json({ success: false }, { status: 429 }));
  expect(await tool().execute(create())).toMatchObject({ success: false });
  expect(calls.some(call => call.table === 'price_lists')).toBe(false);
});

test('unexpected response failure after dispatch does not claim writes never started', async () => {
  const spy = jest.spyOn(batchHandler, 'handlePriceListBatch').mockResolvedValue({
    json: async () => { throw new Error('serialization unavailable'); },
  } as any);
  try {
    expect(await tool().execute(create({ dry_run: false, expected_count: 1 }))).toMatchObject({
      success: false, error: expect.stringContaining('writes may have committed'),
    });
  } finally { spy.mockRestore(); }
});

test('administrative router advertises batches and retains partial failure data', async () => {
  failedWrite = 'price_list_items';
  const router = toolsRouterTool([priceListsTool(site)], { siteId: site, userId: user });
  const result = await router.execute({ action: 'call', name: 'price_lists', args: JSON.stringify(create({ dry_run: false, expected_count: 1 })) });
  expect(result).toMatchObject({ success: false, result: { completed: [{ operation: 'lists_create' }], uncertain_operation: { operation: 'items_set' } } });
  expect(tool().parameters.properties.action.enum).toContain('batch_create');
  expect(priceListsTool(site).parameters.properties.action.enum).toEqual(['list', 'get']);
});

test.each(['batch_create', 'batch_update'])('HTTP denies %s without touching the database', async action => {
  expect((await POST(request({ action, site_id: site, user_id: user }))).status).toBe(403);
  expect(db.from).not.toHaveBeenCalled();
});

test('HTTP reads require validated tenant and authentication; malformed JSON is 400', async () => {
  expect((await POST(request({ action: 'list' }))).status).toBe(400);
  expect((await POST(new NextRequest('https://api.example.test', { method: 'POST', body: '{' }))).status).toBe(400);
  (authorizeCatalogRequest as jest.Mock).mockRejectedValue(new CatalogAuthorizationError(401));
  expect((await POST(request({ action: 'list', site_id: site }))).status).toBe(401);
  expect(db.from).not.toHaveBeenCalled();
});

test('HTTP authenticated list reads always filter to the validated site', async () => {
  expect((await POST(request({ action: 'list', site_id: site, is_active: true }))).status).toBe(200);
  expect(authorizeCatalogRequest).toHaveBeenCalledWith(expect.anything(), { site_id: site, channel: 'tools' });
  expect(calls).toContainEqual({ table: 'price_lists', method: 'eq', args: ['site_id', site] });
  expect(calls).toContainEqual({ table: 'price_lists', method: 'eq', args: ['is_active', true] });
});