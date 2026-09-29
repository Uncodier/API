import { NextRequest } from 'next/server';
const mockIssuer = jest.fn();
const mockUser = jest.fn();
const mockSession = jest.fn();
const mockEpoch = jest.fn();
const mockRpc = jest.fn();
const mockRate = jest.fn();
const mockUpsert = jest.fn();
jest.mock('../token-auth', () => ({
  authenticateIdentityIssuer: (...args: unknown[]) => mockIssuer(...args),
  authenticateFirstPartyUser: (...args: unknown[]) => mockUser(...args),
  requireIdentitySession: (...args: unknown[]) => mockSession(...args),
  identitySessionEpoch: (...args: unknown[]) => mockEpoch(...args),
}));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  rpc: (...args: unknown[]) => mockRpc(...args), from: jest.fn(() => ({ upsert: mockUpsert })),
} }));
jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: (...args: unknown[]) => mockRate(...args) }));
const mockRevoke = jest.fn();
jest.mock('../orchestration-service', () => ({ visitorIdentityService: { revoke: (...args: unknown[]) => mockRevoke(...args) } }));

import { POST as issue } from '@/app/api/visitors/identity/token/route';
import { POST as currentUser } from '@/app/api/visitors/identity/token/current-user/route';
import { POST as exchange } from '@/app/api/visitors/session/[session_id]/identify/token/route';
import { POST as attributes } from '@/app/api/visitors/session/[session_id]/identify/route';
import { POST as legacyAttributes } from '@/app/api/visitors/identify/route';
import { DELETE as logout } from '@/app/api/visitors/session/[session_id]/identify/logout/route';
import { FIRST_PARTY_ISSUER, issueIdentityToken, SUPPORT_SITE_ID, verifyIdentityToken } from '../token-crypto';
import { VisitorIdentityError } from '../contracts';

const sessionId = '11111111-1111-4111-8111-111111111111';
const visitorId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const keyId = '44444444-4444-4444-8444-444444444444';
const context = { params: Promise.resolve({ session_id: sessionId }) };
const expected = { siteId: SUPPORT_SITE_ID, sessionId, visitorId };
const sessionBody = { site_id: SUPPORT_SITE_ID, session_id: sessionId };
const request = (body: unknown, method = 'POST') => new NextRequest('http://localhost/api', {
  method, headers: { 'content-type': 'application/json', 'x-visitor-session-token': 'proof' }, body: JSON.stringify(body),
});
const token = () => issueIdentityToken({
  iss: FIRST_PARTY_ISSUER, sub: userId, site_id: SUPPORT_SITE_ID, session_id: sessionId, visitor_id: visitorId, epoch: 3,
}).identity_token;

describe('identity token route contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VISITOR_IDENTITY_SIGNING_SECRET = 'test-dedicated-secret-123456789012345';
    process.env.VISITOR_IDENTITY_SIGNING_KEY_ID = 'v1';
    mockIssuer.mockResolvedValue({ siteId: SUPPORT_SITE_ID, issuer: `integration:${SUPPORT_SITE_ID}`, keyId, keyFingerprint: 'a'.repeat(64), keyVersion: keyId });
    mockUser.mockResolvedValue({ id: userId, email: 'verified@example.com', email_confirmed_at: '2026-01-01', user_metadata: { name: 'Alice', email: 'spoof@example.com' } });
    mockSession.mockResolvedValue({ ...expected, leadId: null });
    mockEpoch.mockResolvedValue(3);
    mockRate.mockResolvedValue(null);
    mockRpc.mockResolvedValue({ data: { status: 'verified', lead_id: userId, expires_at: '2099-01-01T00:00:00Z' }, error: null });
    mockRevoke.mockResolvedValue(undefined);
    mockUpsert.mockResolvedValue({ error: null });
  });

  it('derives API site and namespace from the exact issuer, not the body', async () => {
    const result = await issue(request({ session_id: sessionId, external_user_id: 'customer-123' }));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const body = await result.json();
    expect(verifyIdentityToken(body.data.identity_token, expected)).toMatchObject({ iss: `integration:${SUPPORT_SITE_ID}`, sub: 'customer-123', key_id: keyId, epoch: 3 });
    expect(mockSession).toHaveBeenCalledWith(expect.anything(), SUPPORT_SITE_ID, sessionId);
  });

  it.each(['site_id', 'user_id', 'lead_id', 'identity_token'])('rejects issuer override %s', async field => {
    const result = await issue(request({ session_id: sessionId, external_user_id: 'customer', [field]: userId }));
    expect(result.status).toBe(400);
  });

  it('derives first-party sub and verified email solely from the auth user', async () => {
    const response = await currentUser(request({ session_id: sessionId }));
    expect(response.status).toBe(200);
    const claims = verifyIdentityToken((await response.json()).data.identity_token, expected);
    expect(claims).toMatchObject({ iss: FIRST_PARTY_ISSUER, sub: userId, email: 'verified@example.com', name: 'Alice' });
    expect(claims.key_id).toBeUndefined();
  });

  it('omits unverified email and rejects body user spoofing', async () => {
    mockUser.mockResolvedValue({ id: userId, email: 'unverified@example.com' });
    const response = await currentUser(request({ session_id: sessionId }));
    expect(verifyIdentityToken((await response.json()).data.identity_token, expected).email).toBeUndefined();
    expect((await currentUser(request({ session_id: sessionId, user_id: userId }))).status).toBe(400);
  });

  it('uses a shared-proxy admission budget and tight authenticated subject budget', async () => {
    await currentUser(request({ session_id: sessionId }));
    expect(mockRate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ namespace: 'visitor-identity-token:current-user', limit: 1200 }));
    expect(mockRate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ identity: userId, limit: 30 }));
  });

  it('exchanges through exactly one atomic RPC with signed claims only', async () => {
    const identityToken = token();
    const response = await exchange(request({ ...sessionBody, identity_token: identityToken }), context);
    expect(await response.json()).toEqual({ success: true, data: { identity_status: 'verified', lead_id: userId, expires_at: '2099-01-01T00:00:00Z' } });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('exchange_visitor_identity_token_v2', expect.objectContaining({ p_epoch: 3, p_subject: userId, p_key_id: null, p_key_version: null, p_session_id: sessionId }));
  });

  it.each(['name', 'email', 'lead_id', 'external_user_id'])('rejects exchange override %s', async field => {
    expect((await exchange(request({ ...sessionBody, identity_token: token(), [field]: 'override' }), context)).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('passes the signed credential version to the version-fenced RPC', async () => {
    const identityToken = issueIdentityToken({
      iss: `integration:${SUPPORT_SITE_ID}`, sub: userId, key_id: keyId,
      key_fingerprint: 'a'.repeat(64), key_version: keyId,
      site_id: SUPPORT_SITE_ID, session_id: sessionId, visitor_id: visitorId, epoch: 3,
    }).identity_token;
    expect((await exchange(request({ ...sessionBody, identity_token: identityToken }), context)).status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('exchange_visitor_identity_token_v2', expect.objectContaining({ p_key_id: keyId, p_key_version: keyId }));
  });

  it.each(['revoked', 'invalid_session', 'invalid_token'])('rejects revoked/replayed grant %s', async status => {
    mockRpc.mockResolvedValue({ data: { status }, error: null });
    expect((await exchange(request({ ...sessionBody, identity_token: token() }), context)).status).toBe(401);
  });

  it('requires logout to switch active users', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'identity_conflict' }, error: null });
    expect((await exchange(request({ ...sessionBody, identity_token: token() }), context)).status).toBe(409);
  });

  it('fails closed on proof, malformed input, and DB outage', async () => {
    mockSession.mockRejectedValueOnce(new VisitorIdentityError('session_forbidden', 'proof', 403));
    expect((await exchange(request({ ...sessionBody, identity_token: token() }), context)).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
    mockRpc.mockResolvedValue({ error: { message: 'db down' }, data: null });
    expect((await exchange(request({ ...sessionBody, identity_token: token() }), context)).status).toBe(503);
    const malformed = new NextRequest('http://localhost/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect((await currentUser(malformed)).status).toBe(400);
    expect((await currentUser(request({ session_id: 'x'.repeat(9000) }))).status).toBe(413);
  });

  it('logout independently requires session proof before canonical revocation', async () => {
    const response = await logout(request(sessionBody, 'DELETE'), context);
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockRevoke).toHaveBeenCalledWith({ siteId: SUPPORT_SITE_ID, sessionId });
  });

  it('plain attributes never issues email challenges or changes identity bindings', async () => {
    const response = await attributes(request({ ...sessionBody, name: 'Untrusted', email: 'person@example.com' }), context);
    expect(await response.json()).toEqual({ success: true, data: { identity_status: 'unverified' } });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ session_id: sessionId, attributes: expect.objectContaining({ email: 'person@example.com' }) }), { onConflict: 'session_id' });
  });

  it('legacy plain identify treats lead hints and email as unverified attributes only', async () => {
    const response = await legacyAttributes(request({ ...sessionBody, id: visitorId, lead_id: userId, traits: { name: 'Untrusted', email: 'person@example.com' } }));
    expect(await response.json()).toEqual({ success: true, data: { identity_status: 'unverified' } });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ attributes: { name: 'Untrusted', email: 'person@example.com' } }), { onConflict: 'session_id' });
  });
});