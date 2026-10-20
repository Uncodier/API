import { randomBytes } from 'node:crypto';
const mockProcess = jest.fn();
const mockBackfill = jest.fn();
jest.mock('../indexing', () => ({ processCatalogEmbeddingBatch: mockProcess, backfillCatalogSearch: mockBackfill }));
import { POST as processPost } from '@/app/api/catalog/index/process/route';
import { POST as backfillPost } from '@/app/api/catalog/index/backfill/route';

describe('internal indexing HTTP endpoints', () => {
  beforeEach(() => { jest.clearAllMocks(); process.env.SERVICE_API_KEY = randomBytes(24).toString('hex'); });
  afterEach(() => { delete process.env.SERVICE_API_KEY; });
  const request = (body: unknown, authenticated = true) => new Request('https://example.invalid/index', {
    method: 'POST', body: JSON.stringify(body), headers: authenticated ? { 'x-api-key': process.env.SERVICE_API_KEY! } : { 'x-api-key-data': '{"isService":true}' },
  });
  it('does not claim jobs from unverified caller headers', async () => {
    expect((await processPost(request({}, false))).status).toBe(401);
    expect((await backfillPost(request({}, false))).status).toBe(401);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockBackfill).not.toHaveBeenCalled();
  });
  it('validates bounds and sends only the allowed options', async () => {
    expect((await processPost(request({ limit: 21 }))).status).toBe(400);
    expect((await backfillPost(request({ limit: 201 }))).status).toBe(400);
    mockProcess.mockResolvedValue({ success: true, processed: 0, failed: 0, remaining: false });
    expect((await processPost(request({}))).status).toBe(200);
    expect(mockProcess).toHaveBeenCalledWith(8);
    mockBackfill.mockResolvedValue({ success: true, processed: 0, next_cursor: null, has_more: false });
    expect((await backfillPost(request({}))).status).toBe(200);
    expect(mockBackfill).toHaveBeenCalledWith({ limit: 100 });
  });
});