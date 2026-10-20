const mockCreate = jest.fn();
const mockRpc = jest.fn();
const mockRead = jest.fn();
const mockWrite = jest.fn();
jest.mock('@/lib/services/ai/openrouter', () => ({
  ...jest.requireActual('@/lib/services/ai/openrouter'),
  createOpenRouterClient: () => ({ embeddings: { create: mockCreate } }),
}));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc } }));
jest.mock('../cache', () => ({
  catalogCacheKey: (namespace: string) => namespace,
  catalogSingleFlight: (_: string, compute: () => unknown) => compute(),
  readCatalogCache: mockRead, writeCatalogCache: mockWrite,
  acquireCatalogLock: async () => null, releaseCatalogLock: jest.fn(),
}));

import { processCatalogEmbeddingBatch } from '../indexing';
import { getCatalogQueryEmbedding } from '../query-embedding';
import { CATALOG_MODEL } from '../contract';

const id = '00000000-0000-4000-8000-000000000001';
const vector = Array(1536).fill(.1);
const job = { id, catalog_item_id: id, site_id: id, document_text: 'Synthetic public product',
  source_hash: 'synthetic-hash', source_revision: 1, claim_token: id };

describe('provider model aliases through the real embeddings service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRead.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ model: 'text-embedding-3-small', data: [{ index: 0, embedding: vector }] });
    mockRpc.mockImplementation((name: string) => ({ abortSignal: async () => ({ error: null,
      data: name === 'catalog_search_refresh_batch' ? 0 : name === 'catalog_search_index_pending' ? false
        : name === 'claim_catalog_embedding_jobs' ? [job] : true }) }));
  });

  it('publishes a valid unprefixed provider response under the canonical stored model', async () => {
    expect(await processCatalogEmbeddingBatch(8)).toMatchObject({ processed: 1, failed: 0 });
    expect(mockRpc).toHaveBeenCalledWith('complete_catalog_embedding_job', expect.objectContaining({ p_model: CATALOG_MODEL }));
    expect(mockRpc.mock.calls.some(([name]) => name === 'fail_catalog_embedding_job')).toBe(false);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: CATALOG_MODEL }), expect.any(Object));
  });

  it('caches a query vector when the provider omits the vendor prefix', async () => {
    expect(await getCatalogQueryEmbedding('Synthetic product query', 'synthetic-scope')).toEqual(vector);
    expect(mockWrite).toHaveBeenCalledWith('query-vector', vector, 86400);
  });

  it.each(['text-embedding-3-large', 'another-provider/text-embedding-3-small'])(
    'does not publish a vector returned by a different model: %s', async model => {
      mockCreate.mockResolvedValue({ model, data: [{ index: 0, embedding: vector }] });
      expect(await processCatalogEmbeddingBatch(8)).toMatchObject({ processed: 0, failed: 1 });
      expect(mockRpc.mock.calls.some(([name]) => name === 'complete_catalog_embedding_job')).toBe(false);
    },
  );
});