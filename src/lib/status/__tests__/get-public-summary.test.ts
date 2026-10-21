const mockFrom = jest.fn();
const mockComputeSlaBySystem = jest.fn();
const mockComputeOverallSla = jest.fn();
const mockAcquireLock = jest.fn();
const mockGetCachedJson = jest.fn();
const mockReleaseLock = jest.fn();
const mockSetCachedJson = jest.fn();
jest.mock('@/lib/status/refresh-passive-summary', () => ({ refreshPassiveSummary: async (summary: unknown) => summary }));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: mockFrom,
  },
}));

jest.mock('@/lib/status/compute-sla', () => ({
  computeSlaBySystem: mockComputeSlaBySystem,
  computeOverallSla: mockComputeOverallSla,
}));

jest.mock('@/lib/security/upstash-rest', () => ({
  acquireLock: mockAcquireLock,
  getCachedJson: mockGetCachedJson,
  releaseLock: mockReleaseLock,
  setCachedJson: mockSetCachedJson,
}));

import {
  getPublicSummary,
  withSummaryFreshness,
  type PublicStatusSummary,
} from '@/lib/status/get-public-summary';

const staleSummary: PublicStatusSummary = {
  overall: 'degraded',
  overallSla24h: 98.5,
  lastRunAt: '2026-09-20T00:00:00.000Z',
  lastTrigger: 'cron_hourly',
  systems: [],
  slaBySystem: {},
};

describe('getPublicSummary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedJson.mockResolvedValue(null);
    mockAcquireLock.mockResolvedValue({
      state: 'acquired',
      token: 'lock-token',
    });
    mockReleaseLock.mockResolvedValue(undefined);
    mockSetCachedJson.mockResolvedValue(true);
    mockComputeSlaBySystem.mockResolvedValue({});
    mockComputeOverallSla.mockReturnValue(null);
  });

  it('serves the stale summary when another request owns the refresh lock', async () => {
    mockGetCachedJson
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(staleSummary)
      .mockResolvedValueOnce(null);
    mockAcquireLock.mockResolvedValue({ state: 'contended' });

    await expect(getPublicSummary()).resolves.toEqual(withSummaryFreshness(staleSummary));
    expect(mockComputeSlaBySystem).not.toHaveBeenCalled();
  });

  it('waits for the owner to populate the cache when no stale copy exists', async () => {
    jest.useFakeTimers();
    try {
      mockGetCachedJson
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(staleSummary);
      mockAcquireLock.mockResolvedValue({ state: 'contended' });

      const summaryPromise = getPublicSummary();
      await jest.advanceTimersByTimeAsync(250);

      await expect(summaryPromise).resolves.toEqual(withSummaryFreshness(staleSummary));
      expect(mockComputeSlaBySystem).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('serves the stale summary when a refresh fails', async () => {
    mockGetCachedJson
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(staleSummary);
    mockComputeSlaBySystem.mockRejectedValue(new Error('database unavailable'));

    await expect(getPublicSummary()).resolves.toEqual(withSummaryFreshness(staleSummary, true));
    expect(mockReleaseLock).toHaveBeenCalledWith(
      'lock:status:public-summary',
      'lock-token',
    );
  });

  it('serves latest evidence without invented metrics when a cold-cache owner remains busy', async () => {
    jest.useFakeTimers();
    try {
      mockGetCachedJson.mockResolvedValue(null);
      mockAcquireLock.mockResolvedValue({ state: 'contended' });
      mockFrom.mockReturnValue({ select: jest.fn().mockReturnValue({ order: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) }),
      }) }) });
      const pending = getPublicSummary();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({ overall: 'degraded', sourceUnavailable: true,
        overallSla24h: null, lastRunAt: null, systems: [] });
      expect(mockComputeSlaBySystem).not.toHaveBeenCalled();
      expect(mockSetCachedJson).not.toHaveBeenCalled();
      expect(mockReleaseLock).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  it('propagates refresh errors when no stale summary exists', async () => {
    mockComputeSlaBySystem.mockRejectedValue(new Error('database unavailable'));

    await expect(getPublicSummary()).rejects.toThrow('database unavailable');
    expect(mockReleaseLock).toHaveBeenCalledWith(
      'lock:status:public-summary',
      'lock-token',
    );
  });

  it('stores fresh and stale copies after a successful refresh', async () => {
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        order: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockResolvedValue({
              data: null,
              error: null,
            }),
          }),
        }),
      }),
    });

    const summary = await getPublicSummary();

    expect(summary.overallSla24h).toBeNull();
    expect(mockSetCachedJson).toHaveBeenNthCalledWith(
      1,
      'cache:status:public-summary:v2',
      expect.objectContaining({ lastRunAt: null, systems: [] }),
      30,
    );
    expect(mockSetCachedJson).toHaveBeenNthCalledWith(
      2,
      'cache:status:public-summary:stale:v2',
      expect.objectContaining({ lastRunAt: null, systems: [] }),
      3600,
    );
  });

  it('expires a cached green snapshot without changing its original timestamp', async () => {
    const old = { ...staleSummary, overall: 'operational' as const };
    mockGetCachedJson.mockResolvedValueOnce(old);
    const result = await getPublicSummary();
    expect(result).toMatchObject({ overall: 'degraded', stale: true, lastRunAt: old.lastRunAt });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('marks failed refreshes distinctly from normal cache hits', () => {
    const fresh = { ...staleSummary, overall: 'operational' as const, lastRunAt: new Date().toISOString() };
    expect(withSummaryFreshness(fresh)).toMatchObject({ stale: false, sourceUnavailable: false, overall: 'operational' });
    expect(withSummaryFreshness(fresh, true)).toMatchObject({ stale: false, sourceUnavailable: true, overall: 'degraded' });
  });
});
