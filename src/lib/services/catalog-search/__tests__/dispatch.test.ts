import { randomBytes } from 'node:crypto';
const mockStart = jest.fn();
jest.mock('@/lib/services/workflow/base-workflow-service', () => ({
  BaseWorkflowService: class { async initializeClient() { return { workflow: { start: mockStart } }; } },
}));
import { startCatalogIndex } from '../dispatch';
import { GET } from '@/app/api/cron/catalog-index/route';

describe('Temporal catalog dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = randomBytes(24).toString('hex');
    mockStart.mockResolvedValue({ workflowId: 'catalog-index-drain' });
  });
  afterEach(() => { delete process.env.CRON_SECRET; delete process.env.CATALOG_INDEXING_ENABLED; });
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
    process.env.CATALOG_INDEXING_ENABLED = 'true';
    expect((await GET(request)).status).toBe(200);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});