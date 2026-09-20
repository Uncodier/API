import { NextRequest, NextResponse } from 'next/server';
import { getAllowedHeaders, getAllowedOrigins } from '../../cors.config.js';
import { apiKeyAuth } from './apiKeyAuth';
import {
  enforceRequestRateLimit,
  type RequestRateLimitPolicy,
} from '@/lib/security/request-rate-limit';
import {
  getCachedJson,
  setCachedJson,
  sha256,
} from '@/lib/security/upstash-rest';

const WEBHOOK_PATHS = new Set([
  '/api/agents/whatsapp',
  '/api/agents/gear/whatsapp/webhook',
  '/api/integrations/whatsapp/webhook',
  '/api/integrations/stripe/webhook',
  '/api/integrations/outstand/webhooks',
  '/api/integrations/zavu/webhook',
  '/api/integrations/zavu/voice-tools',
  '/api/integrations/vercel/webhook',
  '/api/auth/send-email-hook',
]);

const PUBLIC_VISITOR_PATHS = [
  '/api/visitors/track',
  '/api/visitors/track-batch',
  '/api/visitors/record',
  '/api/visitors/session',
  '/api/visitors/identify',
  '/api/visitors/segment',
  '/api/visitors/upload',
];

interface CachedUserValidation {
  valid: boolean;
  userId?: string;
}

export function isWebhookPath(pathname: string): boolean {
  return WEBHOOK_PATHS.has(pathname)
    || pathname.startsWith('/api/integrations/agentmail/webhook/');
}

export function isPublicRequest(pathname: string, method: string): boolean {
  if (pathname.startsWith('/api/public/')) return true;
  if (pathname === '/api/tracking/email' && method === 'GET') return true;
  if (
    method === 'GET'
    && (
      pathname === '/api/status'
      || pathname.startsWith('/api/status/')
      || (pathname.startsWith('/api/ai/') && pathname.endsWith('/health'))
    )
  ) {
    return true;
  }
  return PUBLIC_VISITOR_PATHS.some((path) => (
    pathname === path || pathname.startsWith(`${path}/`)
  ));
}

function isExpensivePath(pathname: string): boolean {
  return (
    (pathname.startsWith('/api/ai/') && !pathname.endsWith('/health'))
    || pathname === '/api/analyze'
    || pathname.startsWith('/api/site/analyze')
    || pathname.startsWith('/api/site/tester')
    || pathname.startsWith('/api/finder/')
    || pathname.startsWith('/api/agents/')
    || pathname.startsWith('/api/robots/')
    || pathname.startsWith('/api/public/image/prompt/')
    || pathname.startsWith('/api/public/video/prompt/')
    || pathname.startsWith('/api/public/icon/prompt/')
    || pathname.startsWith('/api/public/summary/prompt/')
    || pathname.startsWith('/api/workflow/')
    || pathname.startsWith('/api/workflows/')
  );
}

function ratePolicy(pathname: string): RequestRateLimitPolicy {
  if (pathname === '/api/status' || pathname.startsWith('/api/status/')) {
    return {
      namespace: 'status',
      limit: 60,
      windowSeconds: 60,
    };
  }
  if (isWebhookPath(pathname)) {
    return {
      namespace: 'webhook',
      limit: 120,
      windowSeconds: 60,
      failClosed: true,
    };
  }
  if (isExpensivePath(pathname)) {
    return {
      namespace: 'expensive',
      limit: 20,
      windowSeconds: 60,
      failClosed: true,
    };
  }
  if (pathname.startsWith('/api/public/')) {
    return {
      namespace: 'public-read',
      limit: 60,
      windowSeconds: 60,
      failClosed: true,
    };
  }
  if (
    pathname.startsWith('/api/visitors/')
    || pathname === '/api/tracking/email'
  ) {
    return {
      namespace: 'tracking',
      limit: 300,
      windowSeconds: 60,
      failClosed: true,
    };
  }
  if (pathname.startsWith('/api/cron/')) {
    return {
      namespace: 'cron',
      limit: 120,
      windowSeconds: 60,
    };
  }
  return {
    namespace: 'api',
    limit: 300,
    windowSeconds: 60,
    failClosed: true,
  };
}

function positiveIntegerSetting(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isAllowedStaticOrigin(origin: string | null): boolean {
  if (!origin) return true;
  if (process.env.NODE_ENV !== 'production') return true;
  return getAllowedOrigins().includes(origin);
}

function isPlausibleUserJwt(token: string): boolean {
  if (token.length < 32 || token.length > 4_096) return false;
  const parts = token.split('.');
  if (
    parts.length !== 3
    || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    return false;
  }
  try {
    const decodePart = (part: string) => JSON.parse(
      atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(
        Math.ceil(part.length / 4) * 4,
        '=',
      )),
    ) as Record<string, unknown>;
    const header = decodePart(parts[0]);
    const payload = decodePart(parts[1]);
    return (
      typeof header.alg === 'string'
      && header.alg.toLowerCase() !== 'none'
      && typeof payload.sub === 'string'
      && payload.sub.length > 0
      && typeof payload.exp === 'number'
      && Number.isFinite(payload.exp)
      && payload.exp * 1_000 > Date.now()
    );
  } catch {
    return false;
  }
}

function withCors(response: NextResponse, origin: string | null): NextResponse {
  response.headers.set('Vary', 'Origin');
  response.headers.set('X-Middleware-Executed', 'true');
  if (origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return response;
}

async function validateSupabaseBearer(token: string): Promise<CachedUserValidation> {
  const tokenHash = await sha256(token);
  const cacheKey = `auth:user:${tokenHash}`;
  const cached = await getCachedJson<CachedUserValidation>(cacheKey);
  if (cached) return cached;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !anonKey) return { valid: false };

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    const payload = response.ok
      ? await response.json() as { id?: string }
      : null;
    const result: CachedUserValidation = {
      valid: Boolean(payload?.id),
      userId: payload?.id,
    };
    await setCachedJson(cacheKey, result, result.valid ? 60 : 10);
    return result;
  } catch (error) {
    console.error(
      '[Middleware] Supabase bearer validation failed:',
      error instanceof Error ? error.message : error,
    );
    return { valid: false };
  }
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: { code: 'UNAUTHORIZED', message },
    },
    { status: 401 },
  );
}

async function limitApiKeyValidation(
  request: NextRequest,
): Promise<NextResponse | null> {
  const perClient = await enforceRequestRateLimit(request, {
    namespace: 'api-key-validation',
    limit: positiveIntegerSetting(
      'API_KEY_VALIDATION_REQUESTS_PER_MINUTE',
      300,
    ),
    windowSeconds: 60,
    failClosed: true,
  });
  if (perClient) return perClient;
  return enforceRequestRateLimit(request, {
    namespace: 'api-key-validation-global',
    identity: 'global',
    limit: positiveIntegerSetting(
      'API_KEY_VALIDATION_GLOBAL_REQUESTS_PER_MINUTE',
      2_000,
    ),
    windowSeconds: 60,
    failClosed: true,
  });
}

async function limitBearerValidation(
  request: NextRequest,
): Promise<NextResponse | null> {
  const perClient = await enforceRequestRateLimit(request, {
    namespace: 'bearer-validation',
    limit: positiveIntegerSetting(
      'BEARER_VALIDATION_REQUESTS_PER_MINUTE',
      300,
    ),
    windowSeconds: 60,
    failClosed: true,
  });
  if (perClient) return perClient;
  return enforceRequestRateLimit(request, {
    namespace: 'bearer-validation-global',
    identity: 'global',
    limit: positiveIntegerSetting(
      'BEARER_VALIDATION_GLOBAL_REQUESTS_PER_MINUTE',
      2_000,
    ),
    windowSeconds: 60,
    failClosed: true,
  });
}

export default async function requestMiddleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const method = request.method.toUpperCase();
  const origin = request.headers.get('origin');
  const publicRequest = isPublicRequest(pathname, method);
  const webhookRequest = isWebhookPath(pathname);

  const contentLength = Number(request.headers.get('content-length'));
  const maxRequestBytes = pathname === '/api/visitors/upload'
    ? 30 * 1024 * 1024
    : webhookRequest
      ? 1024 * 1024
      : positiveIntegerSetting('API_MAX_REQUEST_BYTES', 2 * 1024 * 1024);
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
      },
      { status: 413 },
    );
  }

  const limited = await enforceRequestRateLimit(
    request,
    ratePolicy(pathname),
  );
  if (limited) return withCors(limited, origin);

  const publicGeneration = (
    pathname.startsWith('/api/public/image/prompt/')
    || pathname.startsWith('/api/public/video/prompt/')
    || pathname.startsWith('/api/public/icon/prompt/')
    || pathname.startsWith('/api/public/summary/prompt/')
  );
  if (publicGeneration) {
    const globallyLimited = await enforceRequestRateLimit(request, {
      namespace: 'public-generation-global',
      identity: 'global',
      limit: positiveIntegerSetting(
        'PUBLIC_GENERATION_GLOBAL_REQUESTS_PER_HOUR',
        200,
      ),
      windowSeconds: 60 * 60,
      failClosed: true,
    });
    if (globallyLimited) return withCors(globallyLimited, origin);
  } else if (webhookRequest) {
    const globallyLimited = await enforceRequestRateLimit(request, {
      namespace: 'webhook-global',
      identity: 'global',
      limit: positiveIntegerSetting(
        'WEBHOOK_GLOBAL_REQUESTS_PER_MINUTE',
        10_000,
      ),
      windowSeconds: 60,
      failClosed: true,
    });
    if (globallyLimited) return withCors(globallyLimited, origin);
  } else if (isExpensivePath(pathname)) {
    const globallyLimited = await enforceRequestRateLimit(request, {
      namespace: 'expensive-global',
      identity: 'global',
      limit: positiveIntegerSetting(
        'EXPENSIVE_API_GLOBAL_REQUESTS_PER_MINUTE',
        2_000,
      ),
      windowSeconds: 60,
      failClosed: true,
    });
    if (globallyLimited) return withCors(globallyLimited, origin);
  } else if (
    pathname.startsWith('/api/public/')
    || pathname === '/api/status'
    || pathname.startsWith('/api/status/')
  ) {
    const globallyLimited = await enforceRequestRateLimit(request, {
      namespace: 'public-read-global',
      identity: 'global',
      limit: positiveIntegerSetting(
        'PUBLIC_API_GLOBAL_REQUESTS_PER_MINUTE',
        1_000,
      ),
      windowSeconds: 60,
      failClosed: true,
    });
    if (globallyLimited) return withCors(globallyLimited, origin);
  } else if (
    pathname.startsWith('/api/visitors/')
    || pathname === '/api/tracking/email'
  ) {
    const globallyLimited = await enforceRequestRateLimit(request, {
      namespace: 'tracking-global',
      identity: 'global',
      limit: positiveIntegerSetting(
        'TRACKING_GLOBAL_REQUESTS_PER_MINUTE',
        50_000,
      ),
      windowSeconds: 60,
      failClosed: true,
    });
    if (globallyLimited) return withCors(globallyLimited, origin);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('x-api-key-data');
  requestHeaders.delete('x-auth-user-id');
  requestHeaders.delete('x-auth-validated');
  const next = () => NextResponse.next({
    request: { headers: requestHeaders },
  });

  const cronSecret = process.env.CRON_SECRET?.trim();
  const authHeader = request.headers.get('authorization');
  const bearer = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;
  if (
    pathname.startsWith('/api/cron/')
    && method === 'GET'
    && cronSecret
    && authHeader === `Bearer ${cronSecret}`
  ) {
    return withCors(next(), origin);
  }

  if (method === 'OPTIONS') {
    if (!publicRequest && !isAllowedStaticOrigin(origin)) {
      return new NextResponse(null, { status: 403 });
    }
    return withCors(
      new NextResponse(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': getAllowedHeaders(),
          'Access-Control-Max-Age': '86400',
        },
      }),
      origin,
    );
  }

  if (webhookRequest) {
    return withCors(next(), origin);
  }

  if (publicRequest) {
    if (bearer && isPlausibleUserJwt(bearer)) {
      const authLimited = await limitBearerValidation(request);
      if (authLimited) return withCors(authLimited, origin);
      const validation = await validateSupabaseBearer(bearer);
      if (!validation.valid || !validation.userId) {
        return withCors(unauthorized('Invalid or expired user token'), origin);
      }
      const principalLimited = await enforceRequestRateLimit(request, {
        namespace: 'authenticated-user',
        identity: validation.userId,
        limit: 600,
        windowSeconds: 60,
        failClosed: true,
      });
      if (principalLimited) return withCors(principalLimited, origin);
      requestHeaders.set('x-auth-validated', 'true');
      requestHeaders.set('x-auth-user-id', validation.userId);
      return withCors(next(), origin);
    }
    if (bearer?.includes('.')) {
      return withCors(unauthorized('Malformed or expired user token'), origin);
    }
    if (request.headers.get('x-api-key') || bearer) {
      const authLimited = await limitApiKeyValidation(request);
      if (authLimited) return withCors(authLimited, origin);
      return withCors(await apiKeyAuth(request), origin);
    }
    return withCors(next(), origin);
  }

  if (!isAllowedStaticOrigin(origin)) {
    return new NextResponse(null, {
      status: 403,
      statusText: 'Forbidden - Origin not allowed',
    });
  }

  if (bearer && isPlausibleUserJwt(bearer)) {
    const authLimited = await limitBearerValidation(request);
    if (authLimited) return withCors(authLimited, origin);
    const validation = await validateSupabaseBearer(bearer);
    if (!validation.valid || !validation.userId) {
      return withCors(unauthorized('Invalid or expired user token'), origin);
    }
    const principalLimited = await enforceRequestRateLimit(request, {
      namespace: 'authenticated-user',
      identity: validation.userId,
      limit: 600,
      windowSeconds: 60,
      failClosed: true,
    });
    if (principalLimited) return withCors(principalLimited, origin);
    requestHeaders.set('x-auth-validated', 'true');
    requestHeaders.set('x-auth-user-id', validation.userId);
    return withCors(next(), origin);
  }
  if (bearer?.includes('.')) {
    return withCors(unauthorized('Malformed or expired user token'), origin);
  }

  const authLimited = await limitApiKeyValidation(request);
  if (authLimited) return withCors(authLimited, origin);
  const apiKeyResponse = await apiKeyAuth(request);
  return withCors(apiKeyResponse, origin);
}
