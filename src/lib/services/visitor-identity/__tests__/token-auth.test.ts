import { createHash } from 'node:crypto';
const mockSingle = jest.fn();
const mockDecrypt = jest.fn();
const mockGetUser = jest.fn();
const mockProof = jest.fn();
const mockQuery: any = { select: jest.fn(() => mockQuery), eq: jest.fn(() => mockQuery), maybeSingle: mockSingle };
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(() => mockQuery) } }));
jest.mock('@/lib/services/api-keys/api-key-crypto', () => ({ decryptApiKey: (...args: unknown[]) => mockDecrypt(...args) }));
jest.mock('@/lib/security/visitor-session-token', () => ({ verifiedVisitorSessionClaims: (...args: unknown[]) => mockProof(...args) }));
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({ auth: { getUser: mockGetUser } })) }));
import { authenticateFirstPartyUser, authenticateIdentityIssuer, requireIdentitySession } from '../token-auth';
import { FIRST_PARTY_AUTH_URL, SUPPORT_SITE_ID } from '../token-crypto';
import { createClient } from '@supabase/supabase-js';

const key = 'key_test_secret';
const keyVersion = '77777777-7777-4777-8777-777777777777';
const keyRow = { id: 'key-id', key_hash: 'encrypted', site_id: SUPPORT_SITE_ID, scopes: ['identity:issue'], status: 'active', expires_at: '2099-01-01', identity_token_version: keyVersion };
const request = (headers: Record<string, string>) => new Request('http://localhost/api', { headers });

describe('identity issuance independent authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSingle.mockResolvedValue({ data: keyRow, error: null });
    mockDecrypt.mockResolvedValue(key);
    mockProof.mockResolvedValue({ visitorId: 'visitor' });
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user', role: 'authenticated' } }, error: null });
  });

  it('requires exact encrypted key match and explicit scoped DB identity:issue permission', async () => {
    await expect(authenticateIdentityIssuer(request({ 'x-api-key': key }))).resolves.toEqual({ siteId: SUPPORT_SITE_ID, issuer: `integration:${SUPPORT_SITE_ID}`, keyId: 'key-id', keyFingerprint: createHash('sha256').update('encrypted').digest('hex'), keyVersion });
    expect(mockQuery.eq).toHaveBeenCalledWith('lookup_hash', createHash('sha256').update(key).digest('hex'));
    expect(mockDecrypt).toHaveBeenCalledWith('encrypted');
  });

  it.each([
    { site_id: null }, { scopes: ['*'] }, { scopes: ['read', 'write'] },
    { status: 'revoked' }, { expires_at: 'invalid' }, { expires_at: '2000-01-01' },
  ])('rejects issuer shortcuts %j', overrides => {
    mockSingle.mockResolvedValue({ data: { ...keyRow, ...overrides }, error: null });
    return expect(authenticateIdentityIssuer(request({ 'x-api-key': key, 'x-api-key-data': '{"isService":true}' }))).rejects.toThrow();
  });

  it.each<Record<string, string>>([{ origin: 'https://example.com' }, { authorization: 'Bearer secret' }, { 'sec-fetch-site': 'same-origin' }])('is S2S only %j', extra => {
    return expect(authenticateIdentityIssuer(request({ 'x-api-key': key, ...extra }))).rejects.toThrow();
  });

  it('rejects forged key lookup collision/decryption mismatch', async () => {
    mockDecrypt.mockResolvedValue('different');
    await expect(authenticateIdentityIssuer(request({ 'x-api-key': key }))).rejects.toThrow('invalid');
  });

  it.each([null, undefined, '', 'invalid-version'])('fails closed without a database-controlled credential version', async version => {
    mockSingle.mockResolvedValue({ data: { ...keyRow, identity_token_version: version }, error: null });
    await expect(authenticateIdentityIssuer(request({ 'x-api-key': key }))).rejects.toMatchObject({ status: 503 });
  });

  it('uses server getUser against the pinned auth realm, not supplied principal headers', async () => {
    const token = 'x'.repeat(40);
    await expect(authenticateFirstPartyUser(request({ authorization: `Bearer ${token}`, 'x-auth-user-id': 'forged' }))).resolves.toMatchObject({ id: 'user' });
    expect(mockGetUser).toHaveBeenCalledWith(token);
    expect(createClient).toHaveBeenCalledWith(FIRST_PARTY_AUTH_URL, expect.any(String), expect.any(Object));
  });

  it.each([null, { id: 'anonymous', role: 'authenticated', is_anonymous: true }, { id: 'service', role: 'service_role' }])('rejects invalid first-party principal', async user => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });
    await expect(authenticateFirstPartyUser(request({ authorization: `Bearer ${'x'.repeat(40)}` }))).rejects.toThrow();
  });

  it('never substitutes generic authenticated site access for visitor proof', async () => {
    await expect(requireIdentitySession(request({ 'x-auth-validated': 'true', 'x-api-key-data': '{"isService":true}' }), SUPPORT_SITE_ID, 'session')).rejects.toThrow('proof');
    expect(mockSingle).not.toHaveBeenCalled();
  });

  it('binds visitor proof to both site/session and the active canonical visitor row', async () => {
    mockSingle.mockResolvedValue({ data: { is_active: true, visitor_id: 'visitor', lead_id: null }, error: null });
    await requireIdentitySession(request({ 'x-visitor-session-token': 'proof' }), SUPPORT_SITE_ID, 'session');
    expect(mockProof).toHaveBeenCalledWith('proof', { siteId: SUPPORT_SITE_ID, sessionId: 'session' });
    expect(mockQuery.eq).toHaveBeenCalledWith('visitor_id', 'visitor');
  });
});