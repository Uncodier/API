const mockRpc = jest.fn();
const mockRead = jest.fn();
const mockWrite = jest.fn();
const mockEmbedding = jest.fn();
const mockSnapshotRead = jest.fn();
const mockSnapshotSave = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc } }));
jest.mock('../query-embedding', () => ({ getCatalogQueryEmbedding: mockEmbedding }));
jest.mock('../snapshots', () => ({ readCatalogSnapshot: mockSnapshotRead, saveCatalogSnapshot: mockSnapshotSave, SNAPSHOT_LIFETIME_MS: 120000 }));
jest.mock('../cache', () => ({
  catalogCacheKey: (kind: string, value: unknown) => `${kind}:${JSON.stringify(value)}`,
  readCatalogCache: mockRead, writeCatalogCache: mockWrite,
  catalogSingleFlight: (_: string, compute: () => unknown) => compute(),
}));
import { searchCatalog } from '../service';
import type { CatalogCandidate } from '../contract';

const site = '00000000-0000-4000-8000-000000000001';
const candidate = (n: number, score = .32): CatalogCandidate => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, site_id: site, score, exact_match: false });
const suggestions = [candidate(2), candidate(3, .28)];
const input = { query: 'sandwich', channel: 'shop', site_id: site, filters: { parent_id: null, is_marketplace_listed: true } };
const principal = { scope: `public:shop:${site}` };
const reply = (data: unknown) => ({ abortSignal: async () => ({ data, error: null }) });
const normal = candidate(10, .5);
function visibilityRace({ cached = false, hideRelated = false, failRelated = false, failVisibility = false } = {}) {
  if (cached) mockRead.mockResolvedValue({ candidates: [normal], mode: 'hybrid', degraded: false, result_kind: 'matched' });
  mockRpc.mockImplementation((name: string, args: Record<string, any>) => {
    if (name === 'catalog_search_revision') return reply('events:1:1');
    if (name === 'catalog_search_visible_ids') {
      if (args.p_ids.includes(normal.id)) return reply([]);
      if (failVisibility) return { abortSignal: async () => ({ data: null, error: { message: 'Unavailable' } }) };
      return reply(hideRelated ? [] : args.p_ids.map((id: string) => ({ id, site_id: site })));
    }
    if (args.p_min_similarity === .25) {
      if (failRelated) return { abortSignal: async () => ({ data: null, error: { message: 'Unavailable' } }) };
      return reply(suggestions);
    }
    return reply(args.p_mode === 'text' ? [normal] : []);
  });
}

describe('shared semantic alternatives', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    process.env.CATALOG_SEMANTIC_SEARCH_ENABLED = 'true';
    mockRead.mockResolvedValue(null); mockSnapshotRead.mockResolvedValue(null);
    mockEmbedding.mockResolvedValue(Array(1536).fill(.1));
    mockRpc.mockImplementation((name: string, args: Record<string, any>) => reply(name === 'catalog_search_revision' ? 'events:1:1'
      : name === 'catalog_search_visible_ids' ? args.p_ids.map((id: string) => ({ id, site_id: site }))
        : args.p_mode === 'semantic' && args.p_min_similarity === .25 ? suggestions : []));
  });
  afterEach(() => { delete process.env.CATALOG_SEMANTIC_SEARCH_ENABLED; jest.restoreAllMocks(); });

  it('returns bounded related-only results when the normal hybrid query has none', async () => {
    expect(await searchCatalog(input, principal)).toMatchObject({ result_kind: 'related', count: 2, mode: 'hybrid', degraded: false });
    expect(mockEmbedding).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('catalog_search_candidates', expect.objectContaining({
      p_query: 'sandwich', p_site_id: site, p_channel: 'shop', p_filters: input.filters,
      p_mode: 'semantic', p_min_similarity: .25, p_limit: 5,
    }));
    expect(mockWrite.mock.calls[0][1]).toHaveProperty('result_kind', 'related');
    expect(mockRead.mock.calls[0][0]).toContain('"relatedMinSimilarity":0.25');
  });

  it.each(['tools', 'shop', 'catalog', 'pos', 'marketplace'])('applies the same fallback policy to %s', async channel => {
    expect(await searchCatalog({ ...input, channel }, principal)).toMatchObject({ result_kind: 'related', count: 2 });
  });

  it('does not dilute existing matches with a weaker fallback', async () => {
    mockRpc.mockImplementation((name: string, args: Record<string, any>) => reply(name === 'catalog_search_revision' ? 'events:1:1'
      : name === 'catalog_search_visible_ids' ? [{ id: suggestions[0].id, site_id: site }]
        : args.p_mode === 'text' ? [suggestions[0]] : []));
    expect(await searchCatalog(input, principal)).toMatchObject({ result_kind: 'matched', count: 1 });
    expect(mockRpc.mock.calls.filter(([name, args]) => name === 'catalog_search_candidates' && args.p_min_similarity === .25)).toHaveLength(0);
  });

  it('does not suggest an alternative code or generate embeddings for exact codes', async () => {
    expect(await searchCatalog({ ...input, query: 'SKU-123' }, principal)).toMatchObject({ result_kind: 'matched', count: 0 });
    expect(mockEmbedding).not.toHaveBeenCalled();
  });

  it('never manufactures suggestions when the embedding provider fails or is disabled', async () => {
    mockEmbedding.mockRejectedValue(new Error('Provider unavailable'));
    expect(await searchCatalog(input, principal)).toMatchObject({ result_kind: 'matched', degraded: true, count: 0 });
    expect(mockWrite).not.toHaveBeenCalled();
    process.env.CATALOG_SEMANTIC_SEARCH_ENABLED = 'false';
    mockEmbedding.mockClear();
    expect(await searchCatalog(input, principal)).toMatchObject({ result_kind: 'matched', mode: 'text', count: 0 });
    expect(mockEmbedding).not.toHaveBeenCalled();
  });

  it('rechecks visibility and does not return candidates hidden after retrieval', async () => {
    mockRpc.mockImplementation((name: string, args: Record<string, any>) => reply(name === 'catalog_search_revision' ? 'events:1:1'
      : name === 'catalog_search_visible_ids' ? [] : args.p_min_similarity === .25 ? suggestions : []));
    expect((await searchCatalog(input, principal)).items).toEqual([]);
  });

  it('pins related ranks across continuation rather than turning them into exact matches', async () => {
    const first = await searchCatalog({ ...input, limit: 1 }, principal);
    mockSnapshotRead.mockResolvedValue(mockSnapshotSave.mock.calls[0][1]);
    mockEmbedding.mockClear(); mockRpc.mockClear();
    const page = await searchCatalog({ ...input, search_id: first.search_id, limit: 1, offset: 1 }, principal);
    expect(page).toMatchObject({ result_kind: 'related', search_id: first.search_id });
    expect(page.items).toEqual([{ id: suggestions[1].id, site_id: site }]);
    expect(mockEmbedding).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['catalog_search_visible_ids']);
  });

  it('rejects provider candidates beyond the requested related limit', async () => {
    mockRpc.mockImplementation((name: string, args: Record<string, any>) => reply(name === 'catalog_search_revision' ? 'events:1:1'
      : name === 'catalog_search_visible_ids' ? [] : args.p_min_similarity === .25 ? Array.from({ length: 6 }, (_, n) => candidate(n + 2)) : []));
    expect(await searchCatalog(input, principal)).toMatchObject({ degraded: true, result_kind: 'matched', count: 0 });
    expect(mockWrite).not.toHaveBeenCalled();
  });
  it('does not accept an oversized related window from the candidate cache', async () => {
    mockRead.mockResolvedValue({ result_kind: 'related', mode: 'hybrid', degraded: false,
      candidates: Array.from({ length: 6 }, (_, n) => candidate(n + 2)) });
    expect(await searchCatalog(input, principal)).toMatchObject({ result_kind: 'related', count: 2 });
    expect(mockEmbedding).toHaveBeenCalledTimes(1);
  });
  it('does not manufacture suggestions when even the related threshold has no candidates', async () => {
    mockRpc.mockImplementation((name: string) => reply(name === 'catalog_search_revision' ? 'events:1:1' : []));
    expect(await searchCatalog(input, principal)).toMatchObject({ result_kind: 'matched', count: 0, mode: 'hybrid', degraded: false });
  });
  it.each(['tools', 'shop', 'catalog', 'pos', 'marketplace'])('recovers %s when live visibility removes every normal match', async channel => {
    visibilityRace();
    const result = await searchCatalog({ ...input, channel }, principal);
    expect(result).toMatchObject({ result_kind: 'related', count: 2, mode: 'hybrid', degraded: false });
    expect(result.items).toEqual(suggestions.map(({ id, site_id }) => ({ id, site_id })));
    expect(mockEmbedding).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls.filter(([name, args]) => name === 'catalog_search_candidates' && args.p_min_similarity === .25)).toHaveLength(1);
    expect(mockRpc).toHaveBeenCalledWith('catalog_search_candidates', expect.objectContaining({
      p_query: input.query, p_site_id: site, p_channel: channel, p_filters: input.filters, p_limit: 5,
    }));
    expect(mockRpc).toHaveBeenLastCalledWith('catalog_search_visible_ids', expect.objectContaining({
      p_site_id: site, p_channel: channel, p_filters: input.filters, p_ids: suggestions.map(item => item.id),
    }));
    expect(mockSnapshotSave.mock.calls[0][1]).toMatchObject({ candidates: suggestions, result_kind: 'related' });
    // Only the original matched window may have been cached before visibility changed.
    expect(mockWrite.mock.calls.every(([, window]) => window.result_kind === 'matched')).toBe(true);
  });
  it('recovers from a cached normal window without overwriting its revision-bound cache', async () => {
    visibilityRace({ cached: true });
    expect(await searchCatalog(input, principal)).toMatchObject({ result_kind: 'related', count: 2 });
    expect(mockEmbedding).toHaveBeenCalledTimes(1);
    expect(mockWrite).not.toHaveBeenCalled();
  });
  it('does not loop if recovered related candidates also lose visibility', async () => {
    visibilityRace({ hideRelated: true });
    expect(await searchCatalog(input, principal)).toMatchObject({ count: 0, degraded: false });
    expect(mockRpc.mock.calls.filter(([name, args]) => name === 'catalog_search_candidates' && args.p_min_similarity === .25)).toHaveLength(1);
  });
  it('degrades safely when post-visibility semantic retrieval fails', async () => {
    visibilityRace({ cached: true, failRelated: true });
    expect(await searchCatalog(input, principal)).toMatchObject({ result_kind: 'matched', mode: 'text', count: 0, degraded: true });
    expect(mockWrite).not.toHaveBeenCalled();
  });
  it('fails closed if recovered candidates cannot be live-checked', async () => {
    visibilityRace({ failVisibility: true });
    await expect(searchCatalog(input, principal)).rejects.toThrow('Catalog visibility unavailable');
    expect(mockSnapshotSave).not.toHaveBeenCalled();
  });
  it('does not re-embed or recover continuations that lost visibility', async () => {
    visibilityRace();
    mockSnapshotRead.mockResolvedValue({ candidates: [normal], mode: 'hybrid', degraded: false, result_kind: 'matched' });
    await expect(searchCatalog({ ...input, search_id: site }, principal)).rejects.toThrow('restart pagination');
    expect(mockEmbedding).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['catalog_search_visible_ids']);
  });
  it('does not replace an offset request without a snapshot with a new related ranking', async () => {
    visibilityRace();
    expect(await searchCatalog({ ...input, offset: 1 }, principal)).toMatchObject({ count: 0, result_kind: 'matched' });
    expect(mockRpc.mock.calls.filter(([name, args]) => name === 'catalog_search_candidates' && args.p_min_similarity === .25)).toHaveLength(0);
  });
  it('pins the recovered related window for subsequent pages', async () => {
    visibilityRace();
    const first = await searchCatalog({ ...input, limit: 1 }, principal);
    mockSnapshotRead.mockResolvedValue(mockSnapshotSave.mock.calls[0][1]);
    mockEmbedding.mockClear(); mockRpc.mockClear();
    expect(await searchCatalog({ ...input, limit: 1, offset: 1, search_id: first.search_id }, principal))
      .toMatchObject({ search_id: first.search_id, result_kind: 'related', items: [{ id: suggestions[1].id, site_id: site }] });
    expect(mockEmbedding).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['catalog_search_visible_ids']);
  });
  it('keeps remaining normal matches rather than replacing a partially hidden window', async () => {
    mockRead.mockResolvedValue({ candidates: [normal, suggestions[0]], mode: 'hybrid', degraded: false, result_kind: 'matched' });
    mockRpc.mockImplementation((name: string) => reply(name === 'catalog_search_revision' ? 'events:1:1'
      : [{ id: suggestions[0].id, site_id: site }]));
    expect(await searchCatalog(input, principal)).toMatchObject({ result_kind: 'matched', count: 1 });
    expect(mockEmbedding).not.toHaveBeenCalled();
  });
  it.each(['code', 'disabled', 'degraded'])('never recovers an ineligible normal window when %s', async reason => {
    visibilityRace();
    if (reason === 'disabled') process.env.CATALOG_SEMANTIC_SEARCH_ENABLED = 'false';
    if (reason === 'degraded') mockEmbedding.mockRejectedValue(new Error('Provider unavailable'));
    expect(await searchCatalog({ ...input, query: reason === 'code' ? 'SKU-123' : input.query }, principal))
      .toMatchObject({ result_kind: 'matched', count: 0, mode: 'text', degraded: reason === 'degraded' });
    expect(mockRpc.mock.calls.filter(([name, args]) => name === 'catalog_search_candidates' && args.p_min_similarity === .25)).toHaveLength(0);
  });
  it('degrades without writing a new cache if embedding recovery on a cache hit fails', async () => {
    visibilityRace({ cached: true });
    mockEmbedding.mockRejectedValue(new Error('Provider unavailable'));
    expect(await searchCatalog(input, principal)).toMatchObject({ result_kind: 'matched', count: 0, mode: 'text', degraded: true });
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls.filter(([name]) => name === 'catalog_search_candidates')).toHaveLength(0);
  });
});