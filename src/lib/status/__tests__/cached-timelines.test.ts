const mockLoad = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockAcquire = jest.fn();
const mockRelease = jest.fn();
jest.mock('@/lib/status/get-system-timelines', () => ({ getSystemTimelines: mockLoad }));
jest.mock('@/lib/security/upstash-rest', () => ({
  getCachedJson: mockGet, setCachedJson: mockSet, acquireLock: mockAcquire, releaseLock: mockRelease,
}));
import { createTimelineCache } from '../cached-timelines';
describe('historical projection cache', () => {
  let getCachedSystemTimelines: ReturnType<typeof createTimelineCache>;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-10-27T12:00:00Z'));
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue(true);
    mockAcquire.mockResolvedValue({ state: 'acquired', token: 'owner-token' });
    mockRelease.mockResolvedValue({ state: 'released' });
    getCachedSystemTimelines = createTimelineCache();
  });
  afterEach(() => jest.useRealTimers());
  it('coalesces simultaneous loads and caches only complete results', async () => {
    let resolve!: (rows: unknown[]) => void;
    mockLoad.mockReturnValue(new Promise(r => { resolve = r; }));
    const one = getCachedSystemTimelines(); const two = getCachedSystemTimelines();
    await jest.advanceTimersByTimeAsync(0);
    resolve([]);
    expect(await one).toEqual([]); expect(await two).toEqual([]);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(expect.stringContaining('timelines:v3:'), [], 60);
    expect(mockAcquire).toHaveBeenCalledWith(expect.stringContaining(':refresh'), 60);
    expect(mockRelease).toHaveBeenCalledWith(expect.stringContaining(':refresh'), 'owner-token');
  });
  it('serves a short-lived cached projection', async () => {
    const rows = [{ systemKey: 'api', days: [] }];
    mockGet.mockResolvedValue(rows);
    expect(await getCachedSystemTimelines()).toBe(rows);
    expect(mockLoad).not.toHaveBeenCalled();
  });
  it('cools down failures without fabricating empty history, then permits retry', async () => {
    mockLoad.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue([]);
    await expect(getCachedSystemTimelines()).rejects.toThrow('Unavailable');
    expect(mockSet).toHaveBeenCalledWith(expect.stringContaining(':retry-after'), true, 30);
    await expect(getCachedSystemTimelines()).rejects.toThrow('temporarily unavailable');
    expect(mockLoad).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(await getCachedSystemTimelines()).toEqual([]);
  });

  it('retains a fresh local result when Redis later becomes unavailable', async () => {
    mockLoad.mockResolvedValue([]);
    await getCachedSystemTimelines();
    mockAcquire.mockResolvedValue({ state: 'unavailable' });
    expect(await getCachedSystemTimelines()).toEqual([]);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    await expect(getCachedSystemTimelines()).rejects.toThrow('temporarily unavailable');
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it.each(['unavailable', 'unconfigured'])('does not start database work when admission is %s', async state => {
    mockAcquire.mockResolvedValue({ state });
    await expect(getCachedSystemTimelines()).rejects.toThrow('temporarily unavailable');
    await expect(getCachedSystemTimelines()).rejects.toThrow('temporarily unavailable');
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockAcquire).toHaveBeenCalledTimes(1);
  });

  it('coalesces independent instances through the shared lock and published result', async () => {
    const redis = new Map<string, unknown>();
    let owner = false;
    mockGet.mockImplementation(async key => redis.get(key) ?? null);
    mockAcquire.mockImplementation(async () => {
      if (owner) return { state: 'contended' };
      owner = true;
      return { state: 'acquired', token: 'shared-owner' };
    });
    mockSet.mockImplementation(async (key, value) => { redis.set(key, value); return true; });
    let complete!: (rows: unknown[]) => void;
    mockLoad.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const reads = Array.from({ length: 20 }, () => createTimelineCache()());
    await jest.advanceTimersByTimeAsync(0);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    complete([]);
    await jest.advanceTimersByTimeAsync(250);
    expect(await Promise.all(reads)).toEqual(Array.from({ length: 20 }, () => []));
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('bounds contention waits and never starts a duplicate scan', async () => {
    mockAcquire.mockResolvedValue({ state: 'contended' });
    const read = expect(getCachedSystemTimelines()).rejects.toThrow('temporarily unavailable');
    await jest.advanceTimersByTimeAsync(2_000);
    await read;
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('observes a shared cooldown before trying to acquire a lock', async () => {
    mockGet.mockImplementation(async key => key.endsWith(':retry-after') ? true : null);
    await expect(getCachedSystemTimelines()).rejects.toThrow('temporarily unavailable');
    expect(mockAcquire).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('rechecks the cache after acquisition to close a completed-owner race', async () => {
    mockGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce([]);
    expect(await getCachedSystemTimelines()).toEqual([]);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('retains admission lease when publishing fails (load failure: %s)', async failure => {
    mockSet.mockResolvedValue(false);
    if (failure) mockLoad.mockRejectedValue(new Error('timeout'));
    else mockLoad.mockResolvedValue([]);
    if (failure) await expect(getCachedSystemTimelines()).rejects.toThrow('timeout');
    else expect(await getCachedSystemTimelines()).toEqual([]);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('does not reuse yesterday\'s local snapshot after UTC rollover', async () => {
    mockLoad.mockResolvedValue([]);
    jest.setSystemTime(new Date('2026-10-27T23:59:59Z'));
    await getCachedSystemTimelines();
    jest.setSystemTime(new Date('2026-10-28T00:00:01Z'));
    await getCachedSystemTimelines();
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });
});