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
jest.mock('@/lib/services/embeddings-service', () => ({
  ...jest.requireActual('@/lib/services/embeddings-service'),
  EmbeddingsService: { generateEmbeddings: mockGenerate },
}));
import { getCatalogQueryEmbedding } from '../query-embedding';
import { CATALOG_MODEL } from '../contract';
import { OpenRouterConfigurationError } from '@/lib/services/ai/openrouter';
import { InvalidEmbeddingsResponseError } from '@/lib/services/embeddings-service';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai/error';

let now = 1_800_000_000_000;
describe('query vector cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    now += 20_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    mockRead.mockResolvedValue(null);
    mockAcquire.mockResolvedValue({ token: 'owner', acquired: true });
    mockGenerate.mockResolvedValue({ model: CATALOG_MODEL, embeddings: [Array(1536).fill(.1)] });
  });
  afterEach(() => jest.restoreAllMocks());
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
    await expect(getCatalogQueryEmbedding('shoe', 'tenant')).rejects.toMatchObject({ reason: 'embedding_lock_contended' });
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });
  it('rejects a different embedding model and never caches it', async () => {
    mockGenerate.mockResolvedValue({ model: 'different-space', embeddings: [Array(1536).fill(.1)] });
    await expect(getCatalogQueryEmbedding('shoe', 'tenant')).rejects.toMatchObject({ reason: 'embedding_model_mismatch' });
    await expect(getCatalogQueryEmbedding('shoe', 'tenant')).rejects.toMatchObject({ reason: 'embedding_circuit_open' });
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });
  it.each([
    [new OpenRouterConfigurationError(), 'embedding_not_configured'],
    [new InvalidEmbeddingsResponseError(), 'embedding_invalid_response'],
    [new SyntaxError('Invalid JSON'), 'embedding_invalid_response'],
    [new APIConnectionTimeoutError(), 'embedding_timeout'],
    [new APIConnectionError({ message: 'Connection unavailable' }), 'embedding_provider_unavailable'],
    [{ status: 401 }, 'embedding_auth_failed'],
    [{ status: 403 }, 'embedding_auth_failed'],
    [{ status: 402 }, 'embedding_funding_exhausted'],
    [{ status: 429 }, 'embedding_rate_limited'],
    [{ status: 408 }, 'embedding_timeout'],
    [{ status: 504 }, 'embedding_timeout'],
    [{ status: 503 }, 'embedding_provider_unavailable'],
    [{ status: 400 }, 'embedding_provider_rejected'],
    [{ status: '429' }, 'embedding_failed'],
    [new Error('Unknown upstream failure'), 'embedding_failed'],
  ])('classifies embedding failures without caching or retrying: %s', async (error, reason) => {
    mockGenerate.mockRejectedValue(error);
    await expect(getCatalogQueryEmbedding('shoe', 'tenant')).rejects.toMatchObject({ reason });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });
  it('keeps the failure circuit temporary and serves cached vectors during it', async () => {
    mockGenerate.mockRejectedValue(new APIConnectionTimeoutError());
    await expect(getCatalogQueryEmbedding('shoe', 'tenant')).rejects.toMatchObject({ reason: 'embedding_timeout' });
    await expect(getCatalogQueryEmbedding('shoe', 'tenant')).rejects.toMatchObject({ reason: 'embedding_circuit_open' });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    mockRead.mockResolvedValueOnce(Array(1536).fill(.2));
    expect(await getCatalogQueryEmbedding('shoe', 'tenant')).toHaveLength(1536);
    jest.mocked(Date.now).mockReturnValue(now + 10_001);
    mockGenerate.mockResolvedValue({ model: CATALOG_MODEL, embeddings: [Array(1536).fill(.1)] });
    expect(await getCatalogQueryEmbedding('shoe', 'tenant')).toHaveLength(1536);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });
  it('identifies an aborted provider deadline even when the SDK reports a user abort', async () => {
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new DOMException('Deadline expired', 'TimeoutError')));
    mockGenerate.mockRejectedValue(new Error('Request was aborted'));
    await expect(getCatalogQueryEmbedding('shoe', 'tenant')).rejects.toMatchObject({ reason: 'embedding_timeout' });
    expect(mockWrite).not.toHaveBeenCalled();
  });
  it.each([Array(1536).fill(0), Array(1536).fill(NaN), [.1]])('rejects invalid query vectors with a safe reason', async vector => {
    mockGenerate.mockResolvedValue({ model: CATALOG_MODEL, embeddings: [vector] });
    await expect(getCatalogQueryEmbedding('shoe', 'tenant')).rejects.toMatchObject({ reason: 'embedding_invalid_response' });
    expect(mockWrite).not.toHaveBeenCalled();
  });
});