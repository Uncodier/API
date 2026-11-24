import { randomBytes } from 'node:crypto';
const mockStart = jest.fn();
const mockQueueObservation = jest.fn();
jest.mock('@/lib/services/workflow/base-workflow-service', () => ({
  BaseWorkflowService: class { async initializeClient() { return { workflow: { start: mockStart } }; } },
}));
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn() }));
jest.mock('../queue-observation', () => ({ observeCatalogIndexQueue: mockQueueObservation }));
import { startCatalogIndex } from '../dispatch';
import { GET } from '@/app/api/cron/catalog-index/route';
import { POST as startPost } from '@/app/api/catalog/index/start/route';

describe('Temporal catalog dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = randomBytes(24).toString('hex');
    mockStart.mockResolvedValue({ workflowId: 'catalog-index-drain' });
    mockQueueObservation.mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.CATALOG_INDEXING_ENABLED;
    delete process.env.SERVICE_API_KEY;
  });
  it('starts only one concurrent drain and allows a later completed run to be replaced', async () => {
    await startCatalogIndex({ backfill: false });
    expect(mockStart).toHaveBeenCalledWith('catalogIndexWorkflow', expect.objectContaining({
      workflowId: 'catalog-index-drain', workflowIdConflictPolicy: 'USE_EXISTING', workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      args: [{ backfill: false }],
    }));
  });
  it('rejects unauthorized cron and stays disabled until explicitly configured', async () => {
    expect((await GET(new Request('https://example.invalid/cron'))).status).toBe(401);
    const request = new Request('https://example.invalid/cron', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    expect(await (await GET(request)).json()).toEqual({ success: true, disabled: true });
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockQueueObservation).not.toHaveBeenCalled();
  });
  it('dispatches only the shared drain on every enabled cron tick', async () => {
    process.env.CATALOG_INDEXING_ENABLED = 'true';
    const tick = () => GET(new Request('https://example.invalid/cron', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    expect(await (await tick()).json()).toEqual({ success: true, workflow_id: 'catalog-index-drain' });
    expect(await (await tick()).json()).toEqual({ success: true, workflow_id: 'catalog-index-drain' });
    const options = expect.objectContaining({
      workflowId: 'catalog-index-drain', args: [{ backfill: false }],
      workflowIdConflictPolicy: 'USE_EXISTING', workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
    expect(mockStart.mock.calls).toEqual([['catalogIndexWorkflow', options], ['catalogIndexWorkflow', options]]);
    expect(mockQueueObservation).toHaveBeenCalledTimes(2);
  });
  it('preserves the dispatch response when the independent check fails', async () => {
    process.env.CATALOG_INDEXING_ENABLED = 'true';
    mockQueueObservation.mockRejectedValueOnce(new Error('Unavailable'));
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await GET(new Request('https://example.invalid/cron', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, workflow_id: 'catalog-index-drain' });
      expect(warning).toHaveBeenCalledWith('[Catalog index queue] observation unavailable');
    } finally { warning.mockRestore(); }
  });
  it('preserves service-authenticated global and cursor-resumed site backfills', async () => {
    process.env.SERVICE_API_KEY = randomBytes(24).toString('hex');
    const site = '10000000-0000-4000-8000-000000000001';
    const cursor = '10000000-0000-4000-8000-000000000002';
    const request = (body: object, key?: string) => new Request('https://example.invalid/api/catalog/index/start', {
      method: 'POST', body: JSON.stringify(body), headers: key ? { 'x-api-key': key } : {},
    });
    const scoped = { site_id: site, after_id: cursor, backfill: true };
    expect((await startPost(request(scoped))).status).toBe(401);
    expect(mockStart).not.toHaveBeenCalled();
    expect((await startPost(request({}, process.env.SERVICE_API_KEY))).status).toBe(200);
    expect((await startPost(request(scoped, process.env.SERVICE_API_KEY))).status).toBe(200);
    expect(mockStart).toHaveBeenNthCalledWith(1, 'catalogIndexWorkflow', expect.objectContaining({
      workflowId: 'catalog-index-backfill:all', args: [{ backfill: true }],
    }));
    expect(mockStart).toHaveBeenNthCalledWith(2, 'catalogIndexWorkflow', expect.objectContaining({
      workflowId: `catalog-index-backfill:${site}`, args: [scoped],
    }));
  });
});