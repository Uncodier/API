import { NextResponse } from 'next/server';
import { checkRateLimit, sha256 } from './upstash-rest';

export interface RequestRateLimitPolicy {
  namespace: string;
  limit: number;
  windowSeconds: number;
  failClosed?: boolean;
  identity?: string;
}

export function getTrustedClientIp(request: Request): string {
  const vercelForwarded = request.headers.get('x-vercel-forwarded-for');
  const forwarded = vercelForwarded || request.headers.get('x-forwarded-for');
  return (
    forwarded?.split(',')[0]?.trim()
    || request.headers.get('cf-connecting-ip')?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'unknown'
  );
}

export function getAuthenticatedRateIdentity(request: Request): string {
  const userId = request.headers.get('x-auth-user-id');
  if (userId) return `user:${userId}`;

  const apiKeyData = request.headers.get('x-api-key-data');
  if (apiKeyData) {
    try {
      const parsed = JSON.parse(apiKeyData) as {
        id?: unknown;
        site_id?: unknown;
      };
      if (typeof parsed.id === 'string') return `api-key:${parsed.id}`;
      if (typeof parsed.site_id === 'string') return `site:${parsed.site_id}`;
    } catch {
      // Ignore malformed internal metadata. Middleware removes client values.
    }
  }
  return `ip:${getTrustedClientIp(request)}`;
}

export function isInternalServiceRequest(request: Request): boolean {
  const apiKeyData = request.headers.get('x-api-key-data');
  if (!apiKeyData) return false;
  try {
    const parsed = JSON.parse(apiKeyData) as { isService?: unknown };
    return parsed.isService === true;
  } catch {
    return false;
  }
}

export function hasAuthenticatedPrincipal(request: Request): boolean {
  return request.headers.get('x-auth-validated') === 'true'
    || Boolean(request.headers.get('x-api-key-data'));
}

export async function enforceRequestRateLimit(
  request: Request,
  policy: RequestRateLimitPolicy,
): Promise<NextResponse | null> {
  const identity = policy.identity || getTrustedClientIp(request);
  const identityHash = await sha256(identity);
  const decision = await checkRateLimit(
    `rate_limit:${policy.namespace}:${identityHash}`,
    policy.limit,
    policy.windowSeconds,
  );

  if (!decision.available && policy.failClosed && process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'RATE_LIMIT_UNAVAILABLE',
          message: 'Request admission is temporarily unavailable',
        },
      },
      { status: 503, headers: { 'Retry-After': '30' } },
    );
  }

  if (decision.success) return null;

  const retryAfter = Math.max(
    1,
    Math.ceil((decision.reset - Date.now()) / 1_000),
  );
  return NextResponse.json(
    {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests',
        retry_after: retryAfter,
      },
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(decision.limit),
        'X-RateLimit-Remaining': String(decision.remaining),
        'X-RateLimit-Reset': String(Math.ceil(decision.reset / 1_000)),
      },
    },
  );
}
