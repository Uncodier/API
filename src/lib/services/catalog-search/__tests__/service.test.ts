const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockRead = jest.fn();
const mockWrite = jest.fn();
const mockEmbedding = jest.fn();
const mockSnapshotRead = jest.fn();
const mockSnapshotSave = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc, from: mockFrom } }));
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
import { randomBytes } from 'node:crypto';
import { CatalogSemanticUnavailableError } from '../semantic-errors';

const site = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const hit = { id, site_id: site, score: 1, exact_match: false };
const input = { query: 'running shoes', channel: 'tools', site_id: site };
const queryResult = (data: unknown) => ({ abortSignal: jest.fn().mockResolvedValue({ data, error: null }) });
describe('catalog shared retrieval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    process.env.CATALOG_SEMANTIC_SEARCH_ENABLED = 'true';
    mockRead.mockResolvedValue(null);
    mockEmbedding.mockResolvedValue([.1]);
    mockSnapshotRead.mockResolvedValue(null);
    mockRpc.mockImplementation((name: string) => queryResult(name === 'catalog_search_revision' ? '1:1'
      : name === 'catalog_search_visible_ids' ? [{ id, site_id: site }] : [hit]));
  });
  afterEach(() => { delete process.env.CATALOG_SEMANTIC_SEARCH_ENABLED; jest.restoreAllMocks(); });
  it('runs both retrieval modes and returns compact, live-checked IDs', async () => {
    const result = await searchCatalog(input, { scope: `site:${site}` });
    expect(result.items).toEqual([{ id, site_id: site }]);
    expect(result).toMatchObject({ mode: 'hybrid', degraded: false, count_kind: 'candidate_window' });
    expect(mockRpc.mock.calls.filter(([name]) => name === 'catalog_search_candidates').map(([, args]) => args.p_mode)).toEqual(['text', 'semantic']);
    expect(mockWrite).toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('[CatalogSearch]', expect.not.objectContaining({ degradationReason: expect.anything() }));
  });
  it('degrades to text without caching degraded results', async () => {
    mockEmbedding.mockRejectedValue(new Error('Provider unavailable'));
    const result = await searchCatalog(input, { scope: 'site' });
    expect(result).toMatchObject({ mode: 'text', degraded: true });
    expect(mockWrite).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('[CatalogSearch]', expect.objectContaining({ degradationReason: 'embedding_failed' }));
  });
  it.each(['embedding_timeout', 'embedding_not_configured', 'embedding_lock_contended', 'embedding_circuit_open'] as const)(
    'logs a safe reason for %s while preserving the public contract', async reason => {
      mockEmbedding.mockRejectedValue(new CatalogSemanticUnavailableError(reason));
      const result = await searchCatalog(input, { scope: 'site' });
      expect(result).toMatchObject({ mode: 'text', degraded: true, items: [{ id, site_id: site }] });
      expect(result).not.toHaveProperty('degradationReason');
      expect(console.info).toHaveBeenCalledWith('[CatalogSearch]', expect.objectContaining({
        searchId: result.search_id, degradationReason: reason,
      }));
      expect(mockSnapshotSave.mock.calls[0][1]).toHaveProperty('degradationReason', reason);
      expect(mockWrite).not.toHaveBeenCalled();
    });
  it.each(['rpc', 'invalid'] as const)('distinguishes a semantic %s failure from an embedding failure', async kind => {
    mockRpc.mockImplementation((name: string, args: { p_mode?: string }) => {
      if (name === 'catalog_search_candidates' && args.p_mode === 'semantic') {
        return kind === 'rpc' ? { abortSignal: jest.fn().mockResolvedValue({ error: { message: 'Unavailable' } }) }
          : queryResult([{ id: 'invalid-id' }]);
      }
      return queryResult(name === 'catalog_search_revision' ? '1:1'
        : name === 'catalog_search_visible_ids' ? [{ id, site_id: site }] : [hit]);
    });
    expect(await searchCatalog(input, { scope: 'site' })).toMatchObject({ mode: 'text', degraded: true });
    expect(console.info).toHaveBeenCalledWith('[CatalogSearch]', expect.objectContaining({ degradationReason:
      kind === 'rpc' ? 'semantic_retrieval_failed' : 'semantic_retrieval_invalid_response' }));
    expect(mockWrite).not.toHaveBeenCalled();
  });
  it('never logs upstream messages, credentials, query text, scope or vectors', async () => {
    const username = randomBytes(16).toString('hex');
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    const scope = randomBytes(16).toString('hex');
    const query = `private query ${randomBytes(16).toString('hex')}`;
    const upstreamUrl = new URL('https://example.invalid/failure');
    upstreamUrl.username = username; upstreamUrl.password = password;
    upstreamUrl.searchParams.set('token', token);
    mockEmbedding.mockRejectedValue(Object.assign(new Error(`${upstreamUrl} ${query}`), {
      code: token, headers: { authorization: token }, cause: { password },
    }));
    await searchCatalog({ ...input, query }, { scope });
    const logs = JSON.stringify(jest.mocked(console.info).mock.calls);
    for (const sensitive of [username, password, token, scope, query, upstreamUrl.href]) expect(logs).not.toContain(sensitive);
    expect(logs).not.toContain('authorization');
    expect(logs).toContain('embedding_failed');
  });
  it('labels a semantic database deadline separately and still returns textual results', async () => {
    const originalTimeout = AbortSignal.timeout;
    jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 3_000
      ? AbortSignal.abort(new DOMException('Deadline expired', 'TimeoutError')) : originalTimeout(ms));
    mockRpc.mockImplementation((name: string, args: { p_mode?: string }) => {
      if (name === 'catalog_search_candidates' && args.p_mode === 'semantic') {
        return { abortSignal: jest.fn().mockResolvedValue({ error: { message: 'Aborted' } }) };
      }
      return queryResult(name === 'catalog_search_revision' ? '1:1'
        : name === 'catalog_search_visible_ids' ? [{ id, site_id: site }] : [hit]);
    });
    expect(await searchCatalog(input, { scope: 'site' })).toMatchObject({ mode: 'text', degraded: true });
    expect(console.info).toHaveBeenCalledWith('[CatalogSearch]', expect.objectContaining({
      degradationReason: 'semantic_retrieval_timeout',
    }));
  });
  it('keeps the original fallback reason on snapshot continuations without new embeddings', async () => {
    mockEmbedding.mockRejectedValue(new CatalogSemanticUnavailableError('embedding_timeout'));
    const first = await searchCatalog(input, { scope: 'site' });
    mockSnapshotRead.mockResolvedValue(mockSnapshotSave.mock.calls[0][1]);
    mockEmbedding.mockClear();
    await searchCatalog({ ...input, search_id: first.search_id }, { scope: 'site' });
    expect(mockEmbedding).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenLastCalledWith('[CatalogSearch]', expect.objectContaining({
      searchId: first.search_id, degradationReason: 'embedding_timeout', cacheHit: true,
    }));
  });
  it('checks current visibility even on a cache hit', async () => {
    mockRead.mockResolvedValue({ candidates: [hit], mode: 'hybrid', degraded: false });
    mockRpc.mockImplementation((name: string) => queryResult(name === 'catalog_search_revision' ? '1:1' : []));
    expect((await searchCatalog(input, { scope: 'site' })).items).toEqual([]);
    expect(mockEmbedding).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('catalog_search_visible_ids', expect.objectContaining({ p_site_id: site, p_ids: [id] }));
  });
  it('fails closed on visibility lookup failure', async () => {
    mockRpc.mockImplementation((name: string) => name === 'catalog_search_visible_ids'
      ? { abortSignal: jest.fn().mockResolvedValue({ error: { message: 'down' } }) }
      : queryResult(name === 'catalog_search_revision' ? '1:1' : [hit]));
    await expect(searchCatalog(input, { scope: 'site' })).rejects.toThrow('visibility');
  });
  it('separates cache keys by scope and filters', async () => {
    await searchCatalog(input, { scope: 'user-a' });
    await searchCatalog({ ...input, filters: { category_id: site } }, { scope: 'user-b' });
    expect(mockRead.mock.calls[0][0]).not.toEqual(mockRead.mock.calls[1][0]);
  });
  it('keeps a stable window identity and rejects mixed continuation windows', async () => {
    const first = await searchCatalog(input, { scope: 'site' });
    mockSnapshotRead.mockResolvedValue(mockSnapshotSave.mock.calls[0][1]);
    const second = await searchCatalog({ ...input, search_id: first.search_id }, { scope: 'site' });
    expect(second.search_id).toBe(first.search_id);
    mockRpc.mockReturnValue(queryResult([]));
    await expect(searchCatalog({ ...input, search_id: first.search_id }, { scope: 'site' })).rejects.toThrow('restart pagination');
  });
  it('does not fail or rerun retrieval when an unrelated revision changes during search', async () => {
    let revision = 0;
    mockRpc.mockImplementation((name: string) => queryResult(name === 'catalog_search_revision' ? `${++revision}:${revision}`
      : name === 'catalog_search_visible_ids' ? [{ id, site_id: site }] : [hit]));
    expect((await searchCatalog(input, { scope: 'site' })).items).toEqual([{ id, site_id: site }]);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls.filter(([name]) => name === 'catalog_search_candidates')).toHaveLength(2);
  });
  it('uses the previous snapshot after provider recovery without recomputing rank', async () => {
    const first = await searchCatalog(input, { scope: 'site' });
    mockSnapshotRead.mockResolvedValue(mockSnapshotSave.mock.calls[0][1]);
    mockEmbedding.mockClear(); mockRpc.mockClear();
    const continuation = await searchCatalog({ ...input, search_id: first.search_id }, { scope: 'site' });
    expect(continuation.search_id).toBe(first.search_id);
    expect(mockEmbedding).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['catalog_search_visible_ids']);
  });
  it('returns a continuation conflict if snapshot is missing rather than silently re-ranking', async () => {
    await expect(searchCatalog({ ...input, search_id: site }, { scope: 'site' })).rejects.toThrow('restart pagination');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});