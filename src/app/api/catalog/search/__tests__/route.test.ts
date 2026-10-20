const mockSearch = jest.fn();
const mockAuthorize = jest.fn();
const mockLimit = jest.fn();
jest.mock('@/lib/services/catalog-search/service', () => ({
  searchCatalog: mockSearch, CatalogSearchChangedError: class extends Error {},
}));
jest.mock('@/lib/services/catalog-search/auth', () => ({
  authorizeCatalogRequest: mockAuthorize, CatalogAuthorizationError: class extends Error { status = 403; },
}));
jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: mockLimit }));
import { POST } from '../route';
import { CatalogAuthorizationError } from '@/lib/services/catalog-search/auth';

const site = '00000000-0000-4000-8000-000000000001';
function request(body: unknown) { return new Request('https://example.invalid/catalog', { method: 'POST', body: JSON.stringify(body) }); }
describe('catalog search HTTP boundary', () => {
  beforeEach(() => { jest.clearAllMocks(); mockAuthorize.mockResolvedValue({ scope: 'site' }); mockLimit.mockResolvedValue(null); });
  it('rejects malformed/oversized search before provider work', async () => {
    expect((await POST(request({ query: 'x'.repeat(201), channel: 'catalog', site_id: site }))).status).toBe(400);
    expect(mockSearch).not.toHaveBeenCalled();
  });
  it('authorizes before cache/search and never accepts a channel as authority', async () => {
    mockAuthorize.mockRejectedValue(new CatalogAuthorizationError());
    expect((await POST(request({ query: 'shoe', channel: 'catalog', site_id: site }))).status).toBe(403);
    expect(mockSearch).not.toHaveBeenCalled();
  });
  it('applies admission and returns non-HTTP-cacheable results', async () => {
    mockSearch.mockResolvedValue({ success: true, items: [], candidate_window_truncated: false });
    const response = await POST(request({ query: 'shoe', channel: 'catalog', site_id: site }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toHaveProperty('candidate_window_truncated', false);
    expect(mockLimit).toHaveBeenCalled();
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, offset: 0 }), { scope: 'site' });
  });
});