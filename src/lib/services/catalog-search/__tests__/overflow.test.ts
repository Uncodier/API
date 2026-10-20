const mockRpc = jest.fn();
const mockRead = jest.fn();
const mockWrite = jest.fn();
const mockEmbedding = jest.fn();
const mockSnapshotRead = jest.fn();
const mockSnapshotSave = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc } }));
jest.mock('../query-embedding', () => ({ getCatalogQueryEmbedding: mockEmbedding }));
jest.mock('../snapshots', () => ({
  readCatalogSnapshot: mockSnapshotRead, saveCatalogSnapshot: mockSnapshotSave, SNAPSHOT_LIFETIME_MS: 120000,
}));
jest.mock('../cache', () => ({
  catalogCacheKey: (kind: string, value: unknown) => `${kind}:${JSON.stringify(value)}`,
  readCatalogCache: mockRead, writeCatalogCache: mockWrite,
  catalogSingleFlight: (_: string, fn: () => unknown) => fn(),
}));
import { searchCatalog } from '../service';
import { fuseCatalogCandidates, type CatalogCandidate, type CatalogSearchResult } from '../contract';

const site = '00000000-0000-4000-8000-000000000001';
const input = { query: 'running shoes', channel: 'tools', site_id: site, limit: 100 };
const principal = { scope: `site:${site}` };
const hits = (count: number, start = 10): CatalogCandidate[] => Array.from({ length: count }, (_, n) => ({
  id: `00000000-0000-4000-8000-${String(n + start).padStart(12, '0')}`,
  site_id: site, score: 1, exact_match: false,
}));
function retrieval(text: CatalogCandidate[], semantic: CatalogCandidate[] = [], hidden: string[] = []) {
  mockRpc.mockImplementation((name: string, args: Record<string, any>) => ({
    abortSignal: jest.fn().mockResolvedValue({ error: null, data: name === 'catalog_search_revision' ? '1:1'
      : name === 'catalog_search_candidates' ? args.p_mode === 'text' ? text : semantic
      : args.p_ids.filter((id: string) => !hidden.includes(id)).map((id: string) => ({ id, site_id: site })) }),
  }));
}
describe('evidence-based candidate overflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    process.env.CATALOG_SEMANTIC_SEARCH_ENABLED = 'false';
    mockRead.mockResolvedValue(null);
    mockSnapshotRead.mockResolvedValue(null);
    mockEmbedding.mockResolvedValue([.1]);
  });
  afterEach(() => { delete process.env.CATALOG_SEMANTIC_SEARCH_ENABLED; jest.restoreAllMocks(); });

  it.each([0, 3, 199, 200, 201])('probes 201 and distinguishes %i eligible text hits without changing pagination', async count => {
    retrieval(hits(count));
    const result = await searchCatalog(input, principal);
    expect(result).toMatchObject({ count: Math.min(count, 200), candidate_window_truncated: count > 200,
      has_more: count > 100, mode: 'text', degraded: false });
    expect(result.items).toHaveLength(Math.min(count, 100));
    expect(mockRpc).toHaveBeenCalledWith('catalog_search_candidates', expect.objectContaining({ p_limit: 201 }));
    expect(mockSnapshotSave.mock.calls[0][1].candidates).toHaveLength(Math.min(count, 200));
  });

  it.each([
    [200, 200, 10, false], // Completely overlapping 200-row lists are not 400 candidates.
    [101, 101, 110, true], // One shared ID leaves 201 unique candidates.
    [201, 201, 10, true],
    [0, 201, 10, true],
  ])('deduplicates text=%i semantic=%i start=%i before setting overflow=%s', async (textCount, semanticCount, start, truncated) => {
    process.env.CATALOG_SEMANTIC_SEARCH_ENABLED = 'true';
    const text = hits(textCount as number);
    const semantic = hits(semanticCount as number, start as number);
    const fused = fuseCatalogCandidates(text, semantic);
    expect(fused).toHaveLength(new Set([...text, ...semantic].map(hit => hit.id)).size);
    retrieval(text, semantic);
    const result = await searchCatalog(input, principal);
    expect(result.candidate_window_truncated).toBe(truncated);
    expect(result.count).toBe(200);
    expect(result.items.map(item => item.id)).toEqual(fused.slice(0, 100).map(item => item.id));
  });

  it('live-checks a disjoint 402-row fusion within the unchanged 400-ID SQL bound', async () => {
    process.env.CATALOG_SEMANTIC_SEARCH_ENABLED = 'true';
    retrieval(hits(201), hits(201, 1000));
    const result = await searchCatalog(input, principal);
    expect(result).toMatchObject({ count: 200, candidate_window_truncated: true });
    expect(mockRpc.mock.calls.filter(([name]) => name === 'catalog_search_visible_ids')
      .map(([, args]) => args.p_ids.length)).toEqual([400, 2]);
  });

  it.each([0, 200])('does not count an ineligible probe or ranked candidate (index %i)', async hiddenIndex => {
    const text = hits(201);
    retrieval(text, [], [text[hiddenIndex].id]);
    const result = await searchCatalog(input, principal);
    expect(result).toMatchObject({ count: 200, candidate_window_truncated: false });
    expect(mockSnapshotSave.mock.calls[0][1].candidates).toHaveLength(200);
  });

  it('rejects oversized retriever output rather than using it as overflow evidence', async () => {
    retrieval(hits(202));
    await expect(searchCatalog(input, principal)).rejects.toThrow();
    expect(mockSnapshotSave).not.toHaveBeenCalled();
  });

  it('does not manufacture overflow from duplicate IDs within a retriever', async () => {
    const text = hits(200);
    retrieval([...text, text[0]]);
    expect(await searchCatalog(input, principal)).toMatchObject({ count: 200, candidate_window_truncated: false });
  });

  it('still reports real textual overflow when semantic retrieval degrades', async () => {
    process.env.CATALOG_SEMANTIC_SEARCH_ENABLED = 'true';
    mockEmbedding.mockRejectedValue(new Error('Provider unavailable'));
    retrieval(hits(201));
    expect(await searchCatalog(input, principal)).toMatchObject({ count: 200, mode: 'text', degraded: true,
      candidate_window_truncated: true });
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockSnapshotSave.mock.calls[0][1]).toMatchObject({ candidate_window_truncated: true });
  });

  it('fails explicitly on pre-migration SQL rejecting the text probe', async () => {
    process.env.CATALOG_SEMANTIC_SEARCH_ENABLED = 'true';
    mockRpc.mockImplementation((name: string) => ({ abortSignal: jest.fn().mockResolvedValue(
      name === 'catalog_search_revision' ? { data: '1:1', error: null }
        : { data: null, error: { code: '22023', message: 'invalid candidate bounds' } }),
    }));
    await expect(searchCatalog(input, principal)).rejects.toThrow('Catalog retrieval unavailable');
    expect(mockSnapshotSave).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('separates immutable snapshot identity when only overflow evidence changes', async () => {
    retrieval(hits(200));
    const complete = await searchCatalog(input, principal);
    retrieval(hits(201));
    const truncated = await searchCatalog(input, principal);
    expect(complete.items).toEqual(truncated.items);
    expect(complete.count).toBe(truncated.count);
    expect(complete.search_id).not.toBe(truncated.search_id);
  });

  it('preserves probe evidence through candidate-cache reuse and pins it in continuations', async () => {
    retrieval(hits(201));
    const first = await searchCatalog(input, principal);
    const cached = mockWrite.mock.calls[0][1];
    expect(cached).toMatchObject({ candidate_window_truncated: true });
    expect(cached.candidates).toHaveLength(201);
    expect(mockRead.mock.calls[0][0]).toContain('"probeLimit":201');
    mockRead.mockResolvedValue(cached);
    mockEmbedding.mockClear(); mockRpc.mockClear();
    const cacheHit = await searchCatalog(input, principal);
    expect(cacheHit).toMatchObject({ search_id: first.search_id, count: 200, candidate_window_truncated: true });
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain('catalog_search_candidates');
    const snapshot = mockSnapshotSave.mock.calls[0][1];
    expect(snapshot.candidates).toHaveLength(200);
    mockSnapshotRead.mockResolvedValue(snapshot);
    retrieval([]); // Provider/catalog changes must not recompute this snapshot's evidence.
    mockRpc.mockClear();
    const page = await searchCatalog({ ...input, search_id: first.search_id, offset: 100 }, principal);
    expect(page).toMatchObject({ count: 200, has_more: false, candidate_window_truncated: true, search_id: first.search_id });
    expect(page.items).toHaveLength(100);
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['catalog_search_visible_ids']);
    expect(mockEmbedding).not.toHaveBeenCalled();
  });

  it('retains legacy snapshot/type compatibility without inferring overflow from count=200', async () => {
    const legacy: CatalogSearchResult = { success: true, items: [], count: 200, count_kind: 'candidate_window',
      has_more: false, mode: 'text', degraded: false, search_id: site };
    expect(legacy.candidate_window_truncated).toBeUndefined();
    mockSnapshotRead.mockResolvedValue({ candidates: hits(200), mode: 'text', degraded: false });
    retrieval([]);
    expect(await searchCatalog({ ...input, search_id: legacy.search_id }, principal))
      .toMatchObject({ count: 200, candidate_window_truncated: false, search_id: legacy.search_id });
  });

  it('pins explicit false through cache and snapshot even if a later retrieval would overflow', async () => {
    retrieval(hits(200));
    const first = await searchCatalog(input, principal);
    const cached = mockWrite.mock.calls[0][1];
    expect(cached).toMatchObject({ candidate_window_truncated: false });
    mockRead.mockResolvedValue(cached);
    retrieval(hits(201));
    expect(await searchCatalog(input, principal)).toMatchObject({ search_id: first.search_id,
      candidate_window_truncated: false, count: 200 });
    mockSnapshotRead.mockResolvedValue(mockSnapshotSave.mock.calls[0][1]);
    mockRpc.mockClear();
    expect(await searchCatalog({ ...input, search_id: first.search_id, offset: 100 }, principal))
      .toMatchObject({ search_id: first.search_id, candidate_window_truncated: false, count: 200 });
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['catalog_search_visible_ids']);
  });
});