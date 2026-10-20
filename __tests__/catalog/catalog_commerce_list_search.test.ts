import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { POST } from '@/app/api/agents/tools/catalog_commerce/route';
import { handleItemAction } from '@/app/api/agents/tools/catalog_commerce/handlers/items';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { searchCatalog, CatalogSearchChangedError } from '@/lib/services/catalog-search/service';
import { authorizeCatalogRequest, CatalogAuthorizationError } from '@/lib/services/catalog-search/auth';
import { loadUnbookableParentIds } from '@/lib/helpers/catalog-bookable';
import { enforceRequestRateLimit } from '@/lib/security/request-rate-limit';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: jest.fn() }));
jest.mock('@/lib/services/catalog-search/service', () => ({
  searchCatalog: jest.fn(),
  CatalogSearchChangedError: class extends Error { constructor() { super('Catalog search changed; restart pagination'); } },
}));
jest.mock('@/lib/services/catalog-search/auth', () => ({
  authorizeCatalogRequest: jest.fn(),
  CatalogAuthorizationError: class extends Error {
    constructor(public status = 403) { super('Catalog search access denied'); }
  },
}));
jest.mock('@/lib/helpers/catalog-bookable', () => ({
  ...jest.requireActual('@/lib/helpers/catalog-bookable'), loadUnbookableParentIds: jest.fn(),
}));

const siteId = randomUUID();
const otherSiteId = randomUUID();
const principal = { scope: `service:tools:${siteId}` };
const searchId = randomUUID();

function item(overrides: Record<string, unknown> = {}) {
  return { id: randomUUID(), site_id: siteId, name: 'Corte', kind: 'service',
    status: 'active', availability_status: 'available', parent_id: null,
    target_sale_price: 250, currency: 'MXN', ...overrides };
}

function chain(data: unknown[], count = data.length, error: unknown = null) {
  const result = { data, count, error };
  return {
    select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(), is: jest.fn().mockReturnThis(), not: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(), range: jest.fn().mockReturnThis(),
    order: jest.fn().mockResolvedValue(result),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
}

function searchResult(items: Array<{ id: string; site_id: string }> = [], overrides = {}) {
  return { success: true as const, items, count: items.length, count_kind: 'candidate_window' as const,
    has_more: false, mode: 'hybrid' as const, degraded: false, search_id: searchId, ...overrides };
}

function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest('https://api.example/api/agents/tools/catalog_commerce', {
    method: 'POST', body: JSON.stringify({ action: 'list', site_id: siteId, search: 'corte caballero', ...overrides }),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(authorizeCatalogRequest).mockResolvedValue(principal);
  jest.mocked(searchCatalog).mockResolvedValue(searchResult());
  jest.mocked(loadUnbookableParentIds).mockResolvedValue([]);
  jest.mocked(enforceRequestRateLimit).mockResolvedValue(null);
});

describe('catalog_commerce shared list search', () => {
  it('preserves the shared related-results classification through tool hydration', async () => {
    const related = item();
    jest.mocked(searchCatalog).mockResolvedValue(searchResult([related], { result_kind: 'related' }));
    jest.mocked(supabaseAdmin.from).mockReturnValue(chain([related]) as never);
    expect(await (await POST(request())).json()).toMatchObject({ result_kind: 'related',
      items: [expect.objectContaining({ id: related.id })], mode: 'hybrid', degraded: false });
  });
  it('passes authenticated scope, intent, filters and cursor then hydrates live fields in rank order', async () => {
    const first = item({ description: 'x'.repeat(900), sku: 'HAIR-123', cost: 75,
      metadata: { private_note: 'private' }, embedding: [1], lowest_sale_price: 190 });
    const second = item({ name: 'Masaje', target_sale_price: 400 });
    const hydration = chain([second, first]);
    jest.mocked(supabaseAdmin.from).mockReturnValue(hydration as never);
    jest.mocked(searchCatalog).mockResolvedValue(searchResult([first, second], { count: 12, has_more: true }));
    const req = request({ limit: 2, offset: 4, search_id: searchId, kind: 'service', is_reservation: false });
    const response = await POST(req);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(authorizeCatalogRequest).toHaveBeenCalledWith(req, expect.objectContaining({ site_id: siteId, channel: 'tools' }));
    expect(enforceRequestRateLimit).toHaveBeenCalledWith(req, {
      namespace: 'catalog-search', identity: principal.scope, limit: 180, windowSeconds: 60, failClosed: true,
    });
    expect(searchCatalog).toHaveBeenCalledWith({ query: 'corte caballero', channel: 'tools', site_id: siteId,
      filters: { kind: 'service', is_reservation: false }, limit: 2, offset: 4, search_id: searchId }, principal);
    expect(body).toMatchObject({ count: 12, count_kind: 'candidate_window', has_more: true,
      mode: 'hybrid', degraded: false, search_id: searchId });
    expect(body.items.map((row: { id: string }) => row.id)).toEqual([first.id, second.id]);
    expect(body.items[0]).toMatchObject({ sku: 'HAIR-123', target_sale_price: 250, currency: 'MXN' });
    expect(body.items[0].description).toHaveLength(320);
    expect(body.items[0]).not.toHaveProperty('cost');
    expect(body.items[0]).not.toHaveProperty('metadata');
    expect(body.items[0]).not.toHaveProperty('lowest_sale_price');
    expect(body.items[0]).not.toHaveProperty('embedding');
    expect(hydration.eq).toHaveBeenCalledWith('site_id', siteId);
    expect(hydration.in).toHaveBeenCalledWith('id', [first.id, second.id]);
    expect(hydration.eq).toHaveBeenCalledWith('is_reservation', false);
    expect(hydration.is).not.toHaveBeenCalledWith('parent_id', null);
    const fields = hydration.select.mock.calls[0][0].split(',');
    expect(fields).not.toContain('*');
    expect(fields).not.toContain('cost');
    expect(fields).not.toContain('metadata');
  });

  it('does not return cross-site, unrelated, removed or newly unavailable rows', async () => {
    const safe = item();
    const foreign = item({ site_id: otherSiteId });
    const removed = item();
    const unavailable = item({ availability_status: 'unavailable' });
    const unrelated = item();
    jest.mocked(searchCatalog).mockResolvedValue(searchResult([safe, foreign, removed, unavailable]));
    const hydration = chain([unrelated, foreign, unavailable, safe]);
    jest.mocked(supabaseAdmin.from).mockReturnValue(hydration as never);
    const body = await (await POST(request())).json();
    expect(body.items.map((row: { id: string }) => row.id)).toEqual([safe.id]);
    expect(hydration.in).toHaveBeenCalledWith('id', [safe.id, removed.id, unavailable.id]);
  });

  it('checks only page parents and fails closed for archived or missing parents', async () => {
    const goodParent = item();
    const archivedParent = item({ status: 'archived' });
    const good = item({ parent_id: goodParent.id });
    const archived = item({ parent_id: archivedParent.id });
    const orphan = item({ parent_id: randomUUID() });
    const hydration = chain([good, archived, orphan]);
    const parents = chain([goodParent, archivedParent]);
    jest.mocked(searchCatalog).mockResolvedValue(searchResult([good, archived, orphan]));
    jest.mocked(supabaseAdmin.from).mockReturnValueOnce(hydration as never).mockReturnValueOnce(parents as never);
    const body = await (await POST(request({ kind: 'variant' }))).json();
    expect(body.items.map((row: { id: string }) => row.id)).toEqual([good.id]);
    expect(parents.eq).toHaveBeenCalledWith('site_id', siteId);
    expect(parents.in).toHaveBeenCalledWith('id', [goodParent.id, archivedParent.id, orphan.parent_id]);
    expect(hydration.not).toHaveBeenCalledWith('parent_id', 'is', null);
    expect(loadUnbookableParentIds).not.toHaveBeenCalled();
  });

  it('preserves explicit administrative availability filters', async () => {
    const archived = item({ status: 'archived' });
    const hydration = chain([archived]);
    jest.mocked(searchCatalog).mockResolvedValue(searchResult([archived]));
    jest.mocked(supabaseAdmin.from).mockReturnValue(hydration as never);
    const response = await POST(request({ status: 'archived', parent_id: null }));
    expect((await response.json()).items[0].id).toBe(archived.id);
    expect(hydration.eq).toHaveBeenCalledWith('status', 'archived');
    expect(hydration.eq).not.toHaveBeenCalledWith('status', 'active');
    expect(hydration.is).toHaveBeenCalledWith('parent_id', null);
  });

  it('returns empty/degraded metadata without a full-catalog fallback', async () => {
    jest.mocked(searchCatalog).mockResolvedValue(searchResult([], { degraded: true, mode: 'text' }));
    const body = await (await POST(request())).json();
    expect(body).toMatchObject({ items: [], count: 0, has_more: false, mode: 'text', degraded: true });
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('bounds huge names, codes and image URLs in the tool context', async () => {
    const huge = item({ name: 'n'.repeat(5000), sku: 's'.repeat(5000), image_url: `https://images.example/${'x'.repeat(5000)}` });
    jest.mocked(searchCatalog).mockResolvedValue(searchResult([huge]));
    jest.mocked(supabaseAdmin.from).mockReturnValue(chain([huge]) as never);
    const body = await (await POST(request())).json();
    expect(body.items[0].name).toHaveLength(240);
    expect(body.items[0].sku).toHaveLength(128);
    expect(body.items[0].image_url).toBeNull();
  });

  it('honors authenticated rate admission before retrieval', async () => {
    jest.mocked(enforceRequestRateLimit).mockResolvedValue(NextResponse.json({ success: false }, { status: 429 }));
    expect((await POST(request())).status).toBe(429);
    expect(searchCatalog).not.toHaveBeenCalled();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('uses the separate server-authorized service rate identity and budget', async () => {
    const servicePrincipal = { ...principal, rateIdentity: 'catalog-service', service: true, aggregateOnly: true };
    jest.mocked(authorizeCatalogRequest).mockResolvedValue(servicePrincipal);
    const req = request();
    expect((await POST(req)).status).toBe(200);
    expect(enforceRequestRateLimit).toHaveBeenCalledWith(req, {
      namespace: 'catalog-search', identity: 'catalog-service', limit: 600, windowSeconds: 60, failClosed: true,
    });
    expect(searchCatalog).toHaveBeenCalledWith(expect.anything(), servicePrincipal);
  });

  it('keeps a trusted service client bucket at the per-client quota', async () => {
    jest.mocked(authorizeCatalogRequest).mockResolvedValue({ ...principal,
      rateIdentity: 'catalog-service:client-bucket', service: true, aggregateOnly: false });
    const req = request();
    expect((await POST(req)).status).toBe(200);
    expect(enforceRequestRateLimit).toHaveBeenCalledWith(req, {
      namespace: 'catalog-search', identity: 'catalog-service:client-bucket', limit: 180, windowSeconds: 60, failClosed: true,
    });
  });

  it.each([401, 403] as const)('rejects unauthorized search (%s) before retrieval', async status => {
    jest.mocked(authorizeCatalogRequest).mockRejectedValue(new CatalogAuthorizationError(status));
    expect((await POST(request())).status).toBe(status);
    expect(searchCatalog).not.toHaveBeenCalled();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('returns 409 instead of mixing changed search windows', async () => {
    jest.mocked(searchCatalog).mockRejectedValue(new CatalogSearchChangedError());
    expect((await POST(request({ search_id: searchId, offset: 50 }))).status).toBe(409);
  });

  it.each([
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '20' }, { limit: null },
    { offset: -1 }, { offset: 0.5 }, { offset: '0' }, { offset: 201 },
    { search: 'x'.repeat(201) }, { search: 123 }, { site_id: undefined }, { site_id: '' },
    { site_id: 'not-a-uuid' }, { is_purchasable: 'false' }, { search_id: 'not-a-uuid' },
  ])('rejects invalid search parameters %j', async params => {
    expect((await POST(request(params))).status).toBe(400);
    expect(searchCatalog).not.toHaveBeenCalled();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('permits bounded endpoint values and preserves exact codes', async () => {
    expect((await POST(request({ search: 'SKU-A_123.45', limit: 100, offset: 200 }))).status).toBe(200);
    expect(searchCatalog).toHaveBeenCalledWith(expect.objectContaining({ query: 'SKU-A_123.45', limit: 100, offset: 200 }), principal);
  });

  it('uses a site-scoped default only for trusted direct callers', async () => {
    await handleItemAction({ action: 'list', site_id: siteId, search: 'Corte' });
    expect(searchCatalog).toHaveBeenCalledWith(expect.anything(), { scope: `site:${siteId}:tools` });
    await expect(handleItemAction({ action: 'list', search: 'Corte' })).rejects.toThrow();
  });
});

describe('catalog_commerce no-query browsing', () => {
  it('also excludes private fields and bounds context when browsing', async () => {
    const row = item({ description: 'x'.repeat(900), cost: 1, metadata: { internal: true }, lowest_sale_price: 2 });
    const browse = chain([row]);
    jest.mocked(supabaseAdmin.from).mockReturnValue(browse as never);
    const body = await (await POST(request({ search: undefined }))).json();
    expect(body.items[0].description).toHaveLength(320);
    expect(body.items[0]).not.toHaveProperty('cost');
    expect(body.items[0]).not.toHaveProperty('metadata');
    expect(body.items[0]).not.toHaveProperty('lowest_sale_price');
    expect(browse.select.mock.calls[0][0]).not.toContain('*');
    expect(browse.select.mock.calls[0][0]).not.toContain('cost');
  });

  it.each([undefined, '', '   '])('retains exact count, order, range and parent behavior (%j)', async search => {
    const row = item();
    const browse = chain([row], 600);
    jest.mocked(loadUnbookableParentIds).mockResolvedValue(['archived-parent']);
    jest.mocked(supabaseAdmin.from).mockReturnValue(browse as never);
    const body = await (await POST(request({ search, limit: 100, offset: 300 }))).json();
    expect(body).toMatchObject({ success: true, items: [row], count: 600 });
    expect(browse.range).toHaveBeenCalledWith(300, 399);
    expect(browse.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(browse.eq).toHaveBeenCalledWith('site_id', siteId);
    expect(browse.or).toHaveBeenCalledWith('parent_id.is.null,parent_id.not.in.(archived-parent)');
    expect(searchCatalog).not.toHaveBeenCalled();
    expect(authorizeCatalogRequest).not.toHaveBeenCalled();
  });

  it.each([{ limit: 0 }, { limit: 101 }, { offset: -1 }, { limit: '50' }, { site_id: undefined }])(
    'bounds browsing parameters %j', async params => {
      expect((await POST(request({ ...params, search: undefined }))).status).toBe(400);
      expect(supabaseAdmin.from).not.toHaveBeenCalled();
    },
  );
});