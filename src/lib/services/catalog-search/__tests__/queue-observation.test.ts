import { observeCatalogIndexQueue } from '../queue-observation';
import { recordTelemetry } from '@/lib/status/telemetry';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));

const abortSignal = jest.fn();
const chain = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), abortSignal };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(supabaseAdmin.from).mockReturnValue(chain as unknown as ReturnType<typeof supabaseAdmin.from>);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it('reports a clean observation with a bounded existence read, without listing or mutating jobs', async () => {
  abortSignal.mockResolvedValue({ data: [], error: null });
  await observeCatalogIndexQueue();
  expect(supabaseAdmin.from).toHaveBeenCalledWith('catalog_embedding_jobs');
  expect(chain.select).toHaveBeenCalledWith('status');
  expect(chain.eq).toHaveBeenCalledWith('status', 'exhausted');
  expect(chain.limit).toHaveBeenCalledWith(1);
  expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(recordTelemetry).toHaveBeenCalledWith('catalog_index_queue', 'up', expect.stringContaining('No exhausted'), expect.any(Number));
  expect(console.warn).not.toHaveBeenCalled();
});

it('alert evidence is independent of dispatch and does not reveal job details', async () => {
  abortSignal.mockResolvedValue({ data: [{ status: 'exhausted', site_id: 'private-marker' }], error: null });
  await observeCatalogIndexQueue();
  expect(recordTelemetry).toHaveBeenCalledWith('catalog_index_queue', 'degraded', expect.stringContaining('operator retry required'), expect.any(Number));
  expect(console.warn).toHaveBeenCalledWith('[Catalog index queue] exhausted');
  expect(JSON.stringify(jest.mocked(recordTelemetry).mock.calls)).not.toContain('private-marker');
});

it.each([{ data: null, error: { message: 'private-marker' } }, { data: [{}], error: null }])(
  'does not report healthy when the queue read errors or is malformed', async result => {
    abortSignal.mockResolvedValue(result);
    await observeCatalogIndexQueue();
    expect(recordTelemetry).toHaveBeenCalledWith('catalog_index_queue', 'degraded', 'Unable to verify exhausted catalog embedding jobs', expect.any(Number));
    expect(console.warn).toHaveBeenCalledWith('[Catalog index queue] unavailable');
  },
);

it('reports the check unavailable without waiting indefinitely for the SDK', async () => {
  jest.useFakeTimers();
  abortSignal.mockReturnValue(new Promise(() => {}));
  const pending = observeCatalogIndexQueue();
  await jest.advanceTimersByTimeAsync(1_500);
  await pending;
  expect(abortSignal.mock.calls[0][0].aborted).toBe(true);
  expect(recordTelemetry).toHaveBeenCalledWith('catalog_index_queue', 'degraded',
    'Unable to verify exhausted catalog embedding jobs', expect.any(Number));
});