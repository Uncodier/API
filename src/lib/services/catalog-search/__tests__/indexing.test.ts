const mockRpc = jest.fn();
const mockGenerate = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc } }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: { generateEmbeddings: mockGenerate } }));
import { processCatalogEmbeddingBatch, backfillCatalogSearch, boundedCatalogEmbeddingInput, CATALOG_EMBEDDING_INPUT_BYTES } from '../indexing';
import { CATALOG_MODEL } from '../contract';

const id = '00000000-0000-4000-8000-000000000001';
const job = { id, catalog_item_id: id, site_id: id, document_text: 'Public running shoe', source_hash: 'hash', source_revision: 2, claim_token: id };
const reply = (data: unknown) => ({ abortSignal: jest.fn().mockResolvedValue({ data, error: null }) });
describe('catalog index activity implementation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRpc.mockImplementation((name: string) => reply(name === 'catalog_search_refresh_batch' ? 0
      : name === 'catalog_search_index_pending' ? false : name === 'claim_catalog_embedding_jobs' ? [job] : true));
    mockGenerate.mockResolvedValue({ embeddings: [Array(1536).fill(.1)], model: CATALOG_MODEL });
  });
  it('claims and persists revision/token fenced vectors, returning counts only', async () => {
    const result = await processCatalogEmbeddingBatch(8);
    expect(result).toEqual({ success: true, processed: 1, failed: 0, stale: 0, refreshed: 0, remaining: false });
    expect(mockRpc).toHaveBeenCalledWith('complete_catalog_embedding_job', expect.objectContaining({
      p_job_id: id, p_claim_token: id, p_source_revision: 2, p_source_hash: 'hash', p_model: CATALOG_MODEL,
    }));
    expect(JSON.stringify(result)).not.toContain('embedding');
    expect(JSON.stringify(result)).not.toContain(job.document_text);
  });
  it('does not count stale saves as processed', async () => {
    mockRpc.mockImplementation((name: string) => reply(name === 'catalog_search_refresh_batch' ? 0 : name === 'claim_catalog_embedding_jobs' ? [job] : false));
    expect(await processCatalogEmbeddingBatch(8)).toMatchObject({ processed: 0, stale: 1 });
  });
  it('records controlled errors and permits delayed durable retries', async () => {
    mockGenerate.mockRejectedValue(new Error('upstream request body private'));
    expect(await processCatalogEmbeddingBatch(1)).toMatchObject({ failed: 1, remaining: false });
    expect(mockRpc).toHaveBeenCalledWith('fail_catalog_embedding_job', {
      p_job_id: id, p_claim_token: id, p_error: 'embedding_failed',
    });
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain('upstream request body private');
  });
  it('returns a resumable ordered backfill cursor', async () => {
    mockRpc.mockReturnValue(reply([{ catalog_item_id: id }]));
    expect(await backfillCatalogSearch({ limit: 1 })).toEqual({ success: true, processed: 1, next_cursor: id, has_more: true });
  });
  it('bounds even a larger internal request to eight claimed jobs per platform invocation', async () => {
    await processCatalogEmbeddingBatch(20);
    expect(mockRpc).toHaveBeenCalledWith('claim_catalog_embedding_jobs', { p_limit: 8, p_lease_seconds: 300 });
  });
  it('isolates a rejected document from valid neighbors', async () => {
    const jobs = [1, 2, 3, 4].map(n => ({ ...job, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, document_text: n === 2 ? 'invalid input' : `valid ${n}` }));
    mockRpc.mockImplementation((name: string) => reply(name === 'catalog_search_refresh_batch' ? 0
      : name === 'catalog_search_index_pending' ? false : name === 'claim_catalog_embedding_jobs' ? jobs : true));
    mockGenerate.mockImplementation(async (text: string) => {
      if (text === 'invalid input') throw new Error('provider rejected input');
      return { embeddings: [Array(1536).fill(.1)], model: CATALOG_MODEL };
    });
    expect(await processCatalogEmbeddingBatch(4)).toMatchObject({ processed: 3, failed: 1 });
    const failures = mockRpc.mock.calls.filter(([name]) => name === 'fail_catalog_embedding_job');
    expect(failures).toHaveLength(1);
    expect(failures[0][1].p_job_id).toBe(jobs[1].id);
  });
  it('caps multibyte input by UTF8 bytes without cutting a surrogate pair', () => {
    const text = boundedCatalogEmbeddingInput('😀'.repeat(6000));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CATALOG_EMBEDDING_INPUT_BYTES);
    expect(text).not.toContain('\uFFFD');
    expect(text).toBe('😀'.repeat(1750));
    expect(boundedCatalogEmbeddingInput('a'.repeat(9000))).toHaveLength(7000);
  });
  it('reports durable lexical refresh progress even without new embeddings', async () => {
    mockRpc.mockImplementation((name: string) => reply(name === 'catalog_search_refresh_batch' ? 100
      : name === 'catalog_search_index_pending' ? true : name === 'claim_catalog_embedding_jobs' ? [] : true));
    expect(await processCatalogEmbeddingBatch(8)).toMatchObject({ processed: 0, refreshed: 100, remaining: true });
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});