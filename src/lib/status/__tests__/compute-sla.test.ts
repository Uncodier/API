const mockHistory = jest.fn();
const mockAggregate = jest.fn();
jest.mock('@/lib/status/history-aggregates', () => ({ getObservedSlaCounts: mockAggregate }));
jest.mock('@/lib/status/get-system-timelines', () => ({ loadStatusHistory: mockHistory }));
import { computeOverallSla, computeSlaBySystem } from '@/lib/status/compute-sla';

describe('observed check success metrics', () => {
  beforeEach(() => { mockHistory.mockReset().mockResolvedValue([]); mockAggregate.mockReset().mockResolvedValue(null); jest.useFakeTimers().setSystemTime(new Date('2026-10-20T19:00:00Z')); });
  afterEach(() => jest.useRealTimers());
  const row = (status: string, ageDays = 0, checks = {}, system_key = 'api') => ({
    id: `${system_key}-${ageDays}-${status}`, system_key, status,
    created_at: new Date(Date.now() - ageDays * 86_400_000).toISOString(), health_payload: { checks },
  });
  it('never represents absence of observed checks as 100%', async () => {
    expect(computeOverallSla({})).toBeNull();
    expect(await computeSlaBySystem()).toEqual({});
    mockHistory.mockResolvedValue([row('skipped'), row('degraded', 0, { verification: 'configuration' })]);
    expect(await computeSlaBySystem()).toEqual({ api: { uptime24h: null, uptime7d: null, uptime30d: null } });
  });
  it('averages observed per-system rates excluding null', () => {
    expect(computeOverallSla({ api: { uptime24h: 100, uptime7d: null, uptime30d: null },
      db: { uptime24h: 90, uptime7d: null, uptime30d: null },
      unknown: { uptime24h: null, uptime7d: null, uptime30d: null } })).toBe(95);
  });
  it('counts checks in their actual windows, excluding legacy unverified checks', async () => {
    mockHistory.mockResolvedValue([row('up'), row('down'), row('skipped'),
      row('degraded', 0, { providers: { openrouter: { configured: true, liveProbe: false, verification: 'configuration' } } }),
      row('up', 2), row('up', 8), row('up', 20), row('up', 0, {}, 'db')]);
    expect(await computeSlaBySystem()).toEqual({ api: { uptime24h: 50, uptime7d: 66.7, uptime30d: 80 },
      db: { uptime24h: 100, uptime7d: 100, uptime30d: 100 } });
    expect(mockHistory).toHaveBeenCalledWith('2026-09-20T19:00:00.000Z', '2026-10-20T19:00:00.000Z');
  });
  it('does not manufacture metrics after history load fails', async () => {
    mockHistory.mockRejectedValue(new Error('History unavailable'));
    await expect(computeSlaBySystem()).rejects.toThrow('History unavailable');
  });
  it('uses compact aggregates without fetching raw rows when available', async () => {
    mockAggregate.mockResolvedValue([{ system_key: 'api', total_24h: 4, up_24h: 3, total_7d: 10, up_7d: 9, total_30d: 20, up_30d: 19 }]);
    expect(await computeSlaBySystem()).toEqual({ api: { uptime24h: 75, uptime7d: 90, uptime30d: 95 } });
    expect(mockHistory).not.toHaveBeenCalled();
  });
});
