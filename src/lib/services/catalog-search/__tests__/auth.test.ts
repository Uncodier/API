import { randomBytes } from 'node:crypto';
const mockUser = jest.fn();
const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockValidateKey = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { auth: { getUser: mockUser }, rpc: mockRpc, from: mockFrom } }));
jest.mock('@/lib/services/api-keys/ApiKeyService', () => ({ ApiKeyService: { validateApiKey: mockValidateKey } }));
import { authorizeCatalogRequest, requireCatalogService } from '../auth';

const site = '00000000-0000-4000-8000-000000000001';
const bearer = () => [1, 2, 3].map(() => randomBytes(16).toString('hex')).join('.');
describe('catalog authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks(); process.env.SERVICE_API_KEY = randomBytes(24).toString('hex');
    mockValidateKey.mockResolvedValue({ isValid: false });
  });
  afterEach(() => { delete process.env.SERVICE_API_KEY; });
  it('does not trust forged internal identity headers', async () => {
    const request = new Request('https://example.invalid/catalog', { headers: {
      'x-api-key-data': JSON.stringify({ isService: true, site_id: site }), 'x-auth-user-id': site,
    } });
    await expect(authorizeCatalogRequest(request, { channel: 'catalog', site_id: site })).rejects.toThrow();
    await expect(requireCatalogService(request)).rejects.toThrow();
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('accepts actual service credential and enforces required site', async () => {
    const request = new Request('https://example.invalid/catalog', { headers: { 'x-api-key': process.env.SERVICE_API_KEY! } });
    await expect(requireCatalogService(request)).resolves.toBeUndefined();
    await expect(authorizeCatalogRequest(request, { channel: 'shop', site_id: site })).resolves.toMatchObject({ scope: `public:shop:${site}`, rateIdentity: 'catalog-service', service: true });
    await expect(authorizeCatalogRequest(request, { channel: 'catalog' })).rejects.toThrow();
  });
  it('verifies user and current site membership before private cache access', async () => {
    mockUser.mockResolvedValue({ data: { user: { id: site } }, error: null });
    mockRpc.mockReturnValue({ abortSignal: jest.fn().mockResolvedValue({ data: false, error: null }) });
    const token = bearer();
    const request = new Request('https://example.invalid/catalog', { headers: { authorization: `Bearer ${token}` } });
    await expect(authorizeCatalogRequest(request, { channel: 'catalog', site_id: site })).rejects.toThrow();
    expect(mockUser).toHaveBeenCalledWith(token);
    expect(mockRpc).toHaveBeenCalledWith('site_user_has_effective_access', { p_site_id: site, p_user_id: site });
  });
  it('shares public cache without letting users exhaust another user admission bucket', async () => {
    const request = new Request('https://example.invalid/catalog', { headers: { authorization: `Bearer ${bearer()}` } });
    mockUser.mockResolvedValueOnce({ data: { user: { id: 'user-one' } }, error: null })
      .mockResolvedValueOnce({ data: { user: { id: 'user-two' } }, error: null });
    const a = await authorizeCatalogRequest(request, { channel: 'marketplace' });
    const b = await authorizeCatalogRequest(request, { channel: 'marketplace' });
    expect(a.scope).toBe(b.scope);
    expect(a.rateIdentity).not.toBe(b.rateIdentity);
  });
  it('accepts a BFF client bucket only after verifying the real service credential', async () => {
    const bucket = randomBytes(32).toString('hex');
    const request = new Request('https://example.invalid/catalog', { headers: {
      'x-api-key': process.env.SERVICE_API_KEY!, 'x-catalog-client-id': bucket,
    } });
    expect(await authorizeCatalogRequest(request, { channel: 'marketplace' })).toMatchObject({
      scope: 'public:marketplace:all', rateIdentity: `catalog-client:${bucket}`, aggregateOnly: false,
    });
    request.headers.set('x-api-key', randomBytes(24).toString('hex'));
    await expect(authorizeCatalogRequest(request, { channel: 'marketplace' })).rejects.toThrow();
  });
  function storedKey(overrides: Record<string, unknown> = {}) {
    const key = { id: site, site_id: site, user_id: site, scopes: ['read'], status: 'active',
      expires_at: new Date(Date.now() + 60_000).toISOString(), ...overrides };
    mockValidateKey.mockResolvedValue({ isValid: true, keyData: key });
    const chain = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
      abortSignal: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue({ data: key, error: null }) };
    mockFrom.mockReturnValue(chain);
    mockRpc.mockReturnValue({ abortSignal: jest.fn().mockResolvedValue({ data: true, error: null }) });
    return key;
  }
  it.each(['x-api-key', 'authorization'])('accepts a current scoped read API key via %s', async header => {
    storedKey();
    const credential = `test_${randomBytes(24).toString('hex')}`;
    const request = new Request('https://example.invalid/catalog', { headers: {
      [header]: header === 'authorization' ? `Bearer ${credential}` : credential,
    } });
    expect(await authorizeCatalogRequest(request, { channel: 'tools', site_id: site })).toMatchObject({
      rateIdentity: expect.stringContaining('catalog-key:'), scope: expect.stringContaining(`:${site}:tools`),
    });
    expect(mockValidateKey).toHaveBeenCalledWith(credential);
    expect(mockUser).not.toHaveBeenCalled();
  });
  it.each([{ scopes: ['write'] }, { site_id: '00000000-0000-4000-8000-000000000002' },
    { status: 'revoked' }, { expires_at: new Date(0).toISOString() }])('rejects revoked, expired, wrong-scope/tenant API keys: %j', async overrides => {
    storedKey(overrides);
    const request = new Request('https://example.invalid/catalog', { headers: { 'x-api-key': `test_${randomBytes(24).toString('hex')}` } });
    await expect(authorizeCatalogRequest(request, { channel: 'tools', site_id: site })).rejects.toThrow();
  });
});