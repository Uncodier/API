const mockRead = jest.fn();
const mockWrite = jest.fn();
const mockAcquire = jest.fn();
const mockRelease = jest.fn();
const mockGenerate = jest.fn();
jest.mock('../cache', () => ({
  catalogCacheKey: (namespace: string, value: unknown) => `${namespace}:${JSON.stringify(value)}`,
  catalogSingleFlight: (_: string, fn: () => unknown) => fn(), readCatalogCache: mockRead,
  writeCatalogCache: mockWrite, acquireCatalogLock: mockAcquire, releaseCatalogLock: mockRelease,
}));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: { generateEmbeddings: mockGenerate } }));
import { getCatalogQueryEmbedding } from '../query-embedding';
import { CATALOG_MODEL } from '../contract';

describe('query vector cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRead.mockResolvedValue(null);
    mockAcquire.mockResolvedValue({ token: 'owner', acquired: true });
    mockGenerate.mockResolvedValue({ model: CATALOG_MODEL, embeddings: [Array(1536).fill(.1)] });
  });
  it('reuses a valid cached vector without locks or paid calls', async () => {
    mockRead.mockResolvedValue(Array(1536).fill(.2));
    expect(await getCatalogQueryEmbedding('shoe', 'site')).toHaveLength(1536);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockAcquire).not.toHaveBeenCalled();
  });
  it('generates with a deadline and writes a day-long model-scoped cache', async () => {
    await getCatalogQueryEmbedding('shoe', 'tenant');
    expect(mockGenerate).toHaveBeenCalledWith('shoe', CATALOG_MODEL, 1536,
      expect.objectContaining({ timeout: 1500, signal: expect.any(AbortSignal) }));
    expect(mockWrite).toHaveBeenCalledWith(expect.stringContaining(CATALOG_MODEL), expect.any(Array), 86400);
    expect(mockRelease).toHaveBeenCalledWith(expect.any(String), 'owner');
  });
  it('does not pay twice under distributed lock contention', async () => {
    mockAcquire.mockResolvedValue({ token: 'not-owner', acquired: false });
    await expect(getCatalogQueryEmbedding('shoe', 'tenant')).rejects.toThrow('being generated');
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });
  it('rejects a different embedding model and never caches it', async () => {
    mockGenerate.mockResolvedValue({ model: 'different-space', embeddings: [Array(1536).fill(.1)] });
    await expect(getCatalogQueryEmbedding('shoe', 'tenant')).rejects.toThrow('unavailable');
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });
});