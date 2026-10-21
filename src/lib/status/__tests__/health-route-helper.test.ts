const mockMaybeSingle = jest.fn();
const mockRun = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(() => ({
  select: jest.fn(() => ({ eq: jest.fn(() => ({ order: jest.fn(() => ({ limit: jest.fn(() => ({ maybeSingle: mockMaybeSingle })) })) })) })),
})) } }));
jest.mock('@/lib/status/handler-registry', () => ({ getHealthHandler: jest.fn(() => ({ runCheck: mockRun })) }));
import { getPersistedHealthResponse, runHealthHandlerResponse } from '../health-route-helper';

describe('persisted health evidence', () => {
  beforeEach(() => { jest.clearAllMocks(); jest.useFakeTimers().setSystemTime(new Date('2026-10-20T19:00:00Z')); });
  afterEach(() => jest.useRealTimers());
  const row = (status = 'up', checks = {}) => ({ status, summary: 'Observed', latency_ms: 10,
    created_at: new Date().toISOString(), health_payload: { checks } });
  it('does not serve an expired green snapshot from its in-memory cache', async () => {
    const data = row(); data.created_at = new Date(Date.now() - 89 * 60_000).toISOString();
    mockMaybeSingle.mockResolvedValue({ data, error: null });
    expect(await (await getPersistedHealthResponse('expiration')).json()).toMatchObject({ status: 'up', stale: false });
    jest.setSystemTime(new Date(Date.now() + 2 * 60_000));
    expect(await (await getPersistedHealthResponse('expiration')).json()).toMatchObject({ status: 'unknown', stale: true, lastObservedStatus: 'up' });
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });
  it('keeps live cache isolated from persisted history', async () => {
    mockRun.mockResolvedValue({ status: 'up', checkedAt: new Date().toISOString(), checks: {} });
    await runHealthHandlerResponse('isolated');
    mockMaybeSingle.mockResolvedValue({ data: row('down'), error: null });
    const response = await getPersistedHealthResponse('isolated');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'down', stale: false });
  });
  it('normalizes legacy configuration-only checks', async () => {
    mockMaybeSingle.mockResolvedValue({ data: row('degraded', { verification: 'configuration' }), error: null });
    expect(await (await getPersistedHealthResponse('configuration')).json()).toMatchObject({ status: 'skipped', stale: false });
  });
  it('reports data-loading errors distinctly', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'Unavailable' } });
    expect((await getPersistedHealthResponse('load-error')).status).toBe(503);
  });
});