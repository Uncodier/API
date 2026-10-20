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
  it.each([false, true])('retains overflow=%s locally and across instances', async truncated => {
    const binding = `overflow-${truncated}`;
    const value = { ...snapshot(binding), candidate_window_truncated: truncated };
    await saveCatalogSnapshot(binding, value);
    expect(await readCatalogSnapshot(binding, binding)).toHaveProperty('candidate_window_truncated', truncated);
    expect(mockWrite).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ candidate_window_truncated: truncated }), 120);
    mockRead.mockResolvedValue(value);
    expect(await readCatalogSnapshot(`${binding}-remote`, binding)).toHaveProperty('candidate_window_truncated', truncated);
  });
  it('allows legacy omission but rejects nonboolean overflow metadata', async () => {
    mockRead.mockResolvedValue(snapshot('legacy-overflow'));
    expect(await readCatalogSnapshot('legacy-overflow', 'legacy-overflow')).not.toBeNull();
    mockRead.mockResolvedValue({ ...snapshot('invalid-overflow'), candidate_window_truncated: 'true' });
    expect(await readCatalogSnapshot('invalid-overflow', 'invalid-overflow')).toBeNull();
  });
  it('preserves the related label across instances and rejects oversized alternatives', async () => {
    mockRead.mockResolvedValue({ ...snapshot('related'), mode: 'hybrid', degraded: false, result_kind: 'related' });
    expect(await readCatalogSnapshot('related', 'related')).toHaveProperty('result_kind', 'related');
    mockRead.mockResolvedValue({ ...snapshot('too-many-related'), result_kind: 'related', candidates:
      Array.from({ length: 6 }, (_, n) => ({ id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
        site_id: '00000000-0000-4000-8000-000000000001', score: .3, exact_match: false })) });
    expect(await readCatalogSnapshot('too-many-related', 'too-many-related')).toBeNull();
  });
});