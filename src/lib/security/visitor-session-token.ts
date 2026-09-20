export interface VisitorSessionClaims {
  siteId: string;
  sessionId: string;
  visitorId: string;
  expiresAt: number;
}

function secret(): string {
  const value = (
    process.env.VISITOR_SESSION_TOKEN_SECRET
    || process.env.ENCRYPTION_KEY
  )?.trim();
  if (!value) {
    throw new Error('VISITOR_SESSION_TOKEN_SECRET is not configured');
  }
  return value;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

async function signature(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  );
  return Buffer.from(signed).toString('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function issueVisitorSessionToken(
  claims: Omit<VisitorSessionClaims, 'expiresAt'>,
  ttlSeconds = 24 * 60 * 60,
): Promise<string> {
  const encodedPayload = encode(JSON.stringify({
    ...claims,
    expiresAt: Date.now() + ttlSeconds * 1_000,
  }));
  return `${encodedPayload}.${await signature(encodedPayload)}`;
}

export async function verifyVisitorSessionToken(
  token: string | null,
  expected: {
    siteId: string;
    sessionId?: string;
    visitorId?: string | null;
  },
): Promise<boolean> {
  return Boolean(await verifiedVisitorSessionClaims(token, expected));
}

export async function verifiedVisitorSessionClaims(
  token: string | null,
  expected: {
    siteId: string;
    sessionId?: string;
    visitorId?: string | null;
  },
): Promise<VisitorSessionClaims | null> {
  if (!token) return null;
  const [encodedPayload, suppliedSignature, ...extra] = token.split('.');
  if (!encodedPayload || !suppliedSignature || extra.length > 0) return null;

  const expectedSignature = await signature(encodedPayload);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;

  try {
    const claims = JSON.parse(decode(encodedPayload)) as VisitorSessionClaims;
    return (
      claims.siteId === expected.siteId
      && (!expected.sessionId || claims.sessionId === expected.sessionId)
      && (!expected.visitorId || claims.visitorId === expected.visitorId)
      && Number.isFinite(claims.expiresAt)
      && claims.expiresAt > Date.now()
    ) ? claims : null;
  } catch {
    return null;
  }
}

export function visitorSessionTokenFromRequest(request: Request): string | null {
  return request.headers.get('x-visitor-session-token');
}
