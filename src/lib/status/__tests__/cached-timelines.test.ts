const mockLoad = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
jest.mock('@/lib/status/get-system-timelines', () => ({ getSystemTimelines: mockLoad }));
jest.mock('@/lib/security/upstash-rest', () => ({ getCachedJson: mockGet, setCachedJson: mockSet }));
import { getCachedSystemTimelines } from '../cached-timelines';
describe('historical projection cache', () => {
  beforeEach(() => { jest.clearAllMocks(); mockGet.mockResolvedValue(null); mockSet.mockResolvedValue(true); });
  it('coalesces simultaneous loads and caches only complete results', async () => {
    let resolve!: (rows: unknown[]) => void;
    mockLoad.mockReturnValue(new Promise(r => { resolve = r; }));
    const one = getCachedSystemTimelines(); const two = getCachedSystemTimelines();
    await Promise.resolve();
    resolve([]);
    expect(await one).toEqual([]); expect(await two).toEqual([]);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(expect.stringContaining('timelines:v2:'), [], 60);
  });
  it('serves a short-lived cached projection', async () => {
    const rows = [{ systemKey: 'api', days: [] }];
    mockGet.mockResolvedValue(rows);
    expect(await getCachedSystemTimelines()).toBe(rows);
    expect(mockLoad).not.toHaveBeenCalled();
  });
  it('does not cache errors as empty data and permits retry', async () => {
    mockLoad.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue([]);
    await expect(getCachedSystemTimelines()).rejects.toThrow('Unavailable');
    expect(mockSet).not.toHaveBeenCalled();
    expect(await getCachedSystemTimelines()).toEqual([]);
  });
});