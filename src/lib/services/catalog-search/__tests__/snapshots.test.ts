const mockRead = jest.fn();
const mockWrite = jest.fn();
jest.mock('../cache', () => ({
  catalogCacheKey: (_: string, value: unknown) => JSON.stringify(value),
  readCatalogCache: mockRead, writeCatalogCache: mockWrite,
}));
import { readCatalogSnapshot, saveCatalogSnapshot } from '../snapshots';

const snapshot = (binding: string) => ({ binding, expiresAt: Date.now() + 120000, candidates: [], mode: 'text' as const, degraded: true });
describe('bounded search snapshots', () => {
  beforeEach(() => { jest.clearAllMocks(); mockRead.mockResolvedValue(null); });
  it('retains a degraded ordering for pagination, independently of shared result caching', async () => {
    await saveCatalogSnapshot('one', snapshot('private-site-a'));
    expect(await readCatalogSnapshot('one', 'private-site-a')).toMatchObject({ mode: 'text', degraded: true });
    expect(mockWrite).toHaveBeenCalledWith(expect.any(String), expect.any(Object), 120);
  });
  it('does not allow a search id to cross tenant/query bindings', async () => {
    await saveCatalogSnapshot('two', snapshot('private-site-a'));
    expect(await readCatalogSnapshot('two', 'private-site-b')).toBeNull();
  });
  it('rejects expired snapshots instead of replacing their ranking', async () => {
    mockRead.mockResolvedValue({ ...snapshot('expired'), expiresAt: Date.now() - 1 });
    expect(await readCatalogSnapshot('three', 'expired')).toBeNull();
  });
  it('preserves allowlisted fallback reasons when reading a cross-instance snapshot', async () => {
    mockRead.mockResolvedValue({ ...snapshot('remote'), degradationReason: 'embedding_timeout' });
    expect(await readCatalogSnapshot('remote', 'remote')).toHaveProperty('degradationReason', 'embedding_timeout');
  });
  it('rejects arbitrary fallback reasons from snapshot storage', async () => {
    mockRead.mockResolvedValue({ ...snapshot('untrusted'), degradationReason: 'upstream raw message' });
    expect(await readCatalogSnapshot('untrusted', 'untrusted')).toBeNull();
  });
});