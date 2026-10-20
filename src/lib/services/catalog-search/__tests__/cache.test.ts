import { catalogCacheKey, catalogSingleFlight, readCatalogCache, writeCatalogCache } from '../cache';
const mockClient = jest.fn();
jest.mock('@/lib/utils/redis-client', () => ({ getRedisClient: () => mockClient() }));

describe('expendable catalog caches', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  afterEach(() => { delete process.env.REDIS_CACHE_URL; delete process.env.REDIS_URL; });
  it('keys never contain raw queries or tenant identifiers and include model identity', () => {
    const query = 'private customer question';
    const a = catalogCacheKey('vector', { query, scope: 'tenant-a', model: 'v1' });
    expect(a).not.toContain(query);
    expect(a).not.toContain('tenant-a');
    expect(a).not.toBe(catalogCacheKey('vector', { query, scope: 'tenant-b', model: 'v1' }));
    expect(a).not.toBe(catalogCacheKey('vector', { query, scope: 'tenant-a', model: 'v2' }));
  });
  it('coalesces same-process callers without caching failures', async () => {
    let finish!: (value: number) => void;
    const compute = jest.fn(() => new Promise<number>(resolve => { finish = resolve; }));
    const a = catalogSingleFlight('same', compute);
    const b = catalogSingleFlight('same', compute);
    finish(4);
    expect(await Promise.all([a, b])).toEqual([4, 4]);
    expect(compute).toHaveBeenCalledTimes(1);
    await expect(catalogSingleFlight('fail', async () => { throw new Error('down'); })).rejects.toThrow();
    await expect(catalogSingleFlight('fail', async () => 5)).resolves.toBe(5);
  });
  it('does not connect to an implicit localhost or block on an unready client', async () => {
    delete process.env.REDIS_CACHE_URL; delete process.env.REDIS_URL;
    expect(await readCatalogCache('none')).toBeNull();
    await writeCatalogCache('none', {}, 1);
    expect(mockClient).not.toHaveBeenCalled();
    process.env.REDIS_CACHE_URL = 'redis://cache.example.test';
    const get = jest.fn();
    mockClient.mockReturnValue({ status: 'connecting', get });
    expect(await readCatalogCache('not-ready')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
  it('treats a cache miss as healthy and can write immediately afterward', async () => {
    process.env.REDIS_CACHE_URL = 'redis://cache.example.test';
    const get = jest.fn().mockResolvedValue(null);
    const set = jest.fn().mockResolvedValue('OK');
    mockClient.mockReturnValue({ status: 'ready', get, set });
    expect(await readCatalogCache('miss')).toBeNull();
    await writeCatalogCache('miss', { ids: [] }, 45);
    expect(set).toHaveBeenCalledWith('miss', '{"ids":[]}', 'EX', expect.any(Number));
  });
});