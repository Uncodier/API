const mockFrom = jest.fn();
const mockComputeSlaBySystem = jest.fn();
const mockComputeOverallSla = jest.fn();
const mockAcquireLock = jest.fn();
const mockGetCachedJson = jest.fn();
const mockReleaseLock = jest.fn();
const mockSetCachedJson = jest.fn();

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

    await expect(getPublicSummary()).resolves.toEqual(staleSummary);
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

      await expect(summaryPromise).resolves.toEqual(staleSummary);
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

    await expect(getPublicSummary()).resolves.toEqual(staleSummary);
    expect(mockReleaseLock).toHaveBeenCalledWith(
      'lock:status:public-summary',
      'lock-token',
    );
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
      'cache:status:public-summary:v1',
      summary,
      30,
    );
    expect(mockSetCachedJson).toHaveBeenNthCalledWith(
      2,
      'cache:status:public-summary:stale:v1',
      summary,
      3600,
    );
  });
});
