import { createHmac } from 'node:crypto';
import { FIRST_PARTY_ISSUER, issueIdentityToken, SUPPORT_SITE_ID, verifyIdentityToken } from '../token-crypto';

const sessionId = '11111111-1111-4111-8111-111111111111';
const visitorId = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const expected = { siteId: SUPPORT_SITE_ID, sessionId, visitorId };
const now = 1_800_000_000_000;
const input = { iss: FIRST_PARTY_ISSUER, sub: 'auth-user', site_id: SUPPORT_SITE_ID, session_id: sessionId, visitor_id: visitorId, epoch: 2 };
const secret = 'dedicated-test-secret-not-for-production-12345';

function resign(overrides: Record<string, unknown>) {
  const original = issueIdentityToken(input, now).identity_token;
  const claims = JSON.parse(Buffer.from(original.split('.')[0], 'base64url').toString());
  const payload = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

describe('dedicated server-issued visitor identity tokens', () => {
  beforeEach(() => {
    process.env.VISITOR_IDENTITY_SIGNING_SECRET = secret;
    process.env.VISITOR_IDENTITY_SIGNING_KEY_ID = 'test-v1';
  });

  it('issues exact 90-second tokens carrying immutable subject and session epoch', () => {
    const issued = issueIdentityToken(input, now);
    expect(issued.expires_at).toBe(new Date(now + 90_000).toISOString());
    expect(verifyIdentityToken(issued.identity_token, expected, now)).toMatchObject(input);
  });

  it.each(['siteId', 'sessionId', 'visitorId'])('rejects cross-%s exchange', field => {
    expect(() => verifyIdentityToken(issueIdentityToken(input, now).identity_token, { ...expected, [field]: other }, now)).toThrow('invalid or expired');
  });

  it.each([
    { purpose: 'visitor_session' }, { version: 2 }, { kid: 'other-key' },
    { exp: now / 1000 }, { exp: now / 1000 + 91 }, { iat: now / 1000 + 1 },
    { epoch: -1 }, { jti: 'invalid' }, { sub: '' }, { unexpected: true },
    { iss: `integration:${SUPPORT_SITE_ID}` }, { key_id: other },
  ])('rejects signed malformed claims %j', patch => {
    expect(() => verifyIdentityToken(resign(patch), expected, now)).toThrow();
  });

  it('rejects expiry and a future issue time without clock leeway', () => {
    const token = issueIdentityToken(input, now).identity_token;
    expect(() => verifyIdentityToken(token, expected, now + 90_000)).toThrow();
    expect(() => verifyIdentityToken(token, expected, now - 1000)).toThrow();
  });

  it.each(['', 'not-a-token', 'a.b.c', 'a.=', 'x'.repeat(4097)])('rejects malformed encoding', token => {
    expect(() => verifyIdentityToken(token, expected, now)).toThrow();
  });

  it('rejects tampered subject and noncanonical signature', () => {
    const token = issueIdentityToken(input, now).identity_token;
    const [payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'another-user' })).toString('base64url');
    expect(() => verifyIdentityToken(`${forged}.${signature}`, expected, now)).toThrow();
    expect(() => verifyIdentityToken(`${payload}.${signature}=`, expected, now)).toThrow();
  });

  it('uses explicit integration credentials without changing the stable issuer namespace', () => {
    const claims = { ...input, iss: `integration:${SUPPORT_SITE_ID}`, key_id: other, key_fingerprint: 'a'.repeat(64), key_version: other };
    expect(verifyIdentityToken(issueIdentityToken(claims, now).identity_token, expected, now)).toMatchObject(claims);
  });

  it('requires material binding for an integration token and rejects it for first-party users', () => {
    expect(() => verifyIdentityToken(resign({ iss: `integration:${SUPPORT_SITE_ID}`, key_id: other }), expected, now)).toThrow();
    expect(() => verifyIdentityToken(resign({ key_fingerprint: 'a'.repeat(64) }), expected, now)).toThrow();
  });

  it.each([undefined, null, '', 'not-a-version'])('rejects unversioned or malformed integration assertions', keyVersion => {
    expect(() => verifyIdentityToken(resign({
      iss: `integration:${SUPPORT_SITE_ID}`, key_id: other,
      key_fingerprint: 'a'.repeat(64), key_version: keyVersion,
    }), expected, now)).toThrow();
  });

  it('forbids integration credential versions on first-party assertions', () => {
    expect(() => verifyIdentityToken(resign({ key_version: other }), expected, now)).toThrow();
  });

  it.each([undefined, '', 'short'])('never falls back to session or encryption secrets', value => {
    if (value === undefined) delete process.env.VISITOR_IDENTITY_SIGNING_SECRET;
    else process.env.VISITOR_IDENTITY_SIGNING_SECRET = value;
    process.env.VISITOR_SESSION_TOKEN_SECRET = secret;
    process.env.ENCRYPTION_KEY = secret;
    expect(() => issueIdentityToken(input, now)).toThrow('unavailable');
  });
});