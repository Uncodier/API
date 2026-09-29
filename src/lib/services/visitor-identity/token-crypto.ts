import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { VisitorIdentityError } from './contracts';

export const IDENTITY_TOKEN_TTL_SECONDS = 90;
export const SUPPORT_SITE_ID = '9be0a6a2-5567-41bf-ad06-cb4014f0faf2';
export const FIRST_PARTY_ISSUER = 'supabase:rnjgeloamtszdjplmqxy';
export const FIRST_PARTY_AUTH_URL = 'https://rnjgeloamtszdjplmqxy.supabase.co';

export const IdentityClaimsSchema = z.object({
  purpose: z.literal('visitor_identity'),
  version: z.literal(1),
  kid: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  iss: z.string().max(100),
  key_id: z.string().uuid().optional(),
  key_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  key_version: z.string().uuid().optional(),
  sub: z.string().min(1).max(255),
  site_id: z.string().uuid(),
  session_id: z.string().uuid(),
  visitor_id: z.string().uuid(),
  epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  jti: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().email().max(320).optional(),
}).strict();

export type IdentityTokenClaims = z.infer<typeof IdentityClaimsSchema>;
type IssueClaims = Omit<IdentityTokenClaims, 'purpose' | 'version' | 'kid' | 'jti' | 'iat' | 'exp'>;

function signingConfig() {
  const secret = process.env.VISITOR_IDENTITY_SIGNING_SECRET;
  const kid = process.env.VISITOR_IDENTITY_SIGNING_KEY_ID;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || !kid || !/^[a-zA-Z0-9_-]{1,64}$/.test(kid)) {
    throw new VisitorIdentityError('identity_configuration_error', 'Identity signing is unavailable', 503);
  }
  return { secret, kid };
}

function invalidToken(): never {
  throw new VisitorIdentityError('invalid_identity_token', 'Identity token is invalid or expired', 401);
}

export function issueIdentityToken(input: IssueClaims, now = Date.now()) {
  const { secret, kid } = signingConfig();
  const iat = Math.floor(now / 1000);
  const claims = IdentityClaimsSchema.parse({
    ...input, purpose: 'visitor_identity', version: 1, kid,
    jti: randomUUID(), iat, exp: iat + IDENTITY_TOKEN_TTL_SECONDS,
  });
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return { identity_token: `${payload}.${signature}`, expires_at: new Date(claims.exp * 1000).toISOString() };
}

export function verifyIdentityToken(
  token: string,
  expected: { siteId: string; sessionId: string; visitorId: string },
  now = Date.now(),
): IdentityTokenClaims {
  const { secret, kid } = signingConfig();
  if (token.length > 4096) invalidToken();
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) invalidToken();
  const [payload, supplied] = parts;
  const signature = createHmac('sha256', secret).update(payload).digest();
  const decoded = Buffer.from(supplied, 'base64url');
  if (decoded.toString('base64url') !== supplied || decoded.length !== signature.length
    || !timingSafeEqual(decoded, signature)) invalidToken();
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { invalidToken(); }
  const parsed = IdentityClaimsSchema.safeParse(raw);
  if (!parsed.success) invalidToken();
  const claims = parsed.data;
  const seconds = Math.floor(now / 1000);
  if (claims.kid !== kid || claims.iat > seconds || claims.exp <= seconds
    || claims.exp - claims.iat !== IDENTITY_TOKEN_TTL_SECONDS
    || claims.site_id !== expected.siteId || claims.session_id !== expected.sessionId
    || claims.visitor_id !== expected.visitorId
    || (claims.iss.startsWith('integration:') && (!claims.key_id || !claims.key_fingerprint || !claims.key_version))
    || (claims.iss === FIRST_PARTY_ISSUER && Boolean(claims.key_id || claims.key_fingerprint || claims.key_version))
    || (claims.iss !== `integration:${claims.site_id}`
      && !(claims.iss === FIRST_PARTY_ISSUER && claims.site_id === SUPPORT_SITE_ID))) invalidToken();
  return claims;
}