import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import {
  enforceRequestRateLimit,
  type RequestRateLimitPolicy,
} from '@/lib/security/request-rate-limit';

function positiveIntegerSetting(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function isExpensivePath(pathname: string): boolean {
  return (
    (pathname.startsWith('/api/ai/') && !pathname.endsWith('/health'))
    || pathname === '/api/analyze'
    || pathname.startsWith('/api/site/analyze')
    || pathname.startsWith('/api/site/tester')
    || pathname.startsWith('/api/finder/')
    || pathname === '/api/integrations/icypeas/email-search/resolve'
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

export function usesRouteLevelGenerationRateLimit(
  pathname: string,
  method: string,
): boolean {
  return method === 'GET'
    && pathname.startsWith('/api/public/image/prompt/');
}

export function requestRatePolicy(
  pathname: string,
  webhookRequest: boolean,
): RequestRateLimitPolicy {
  if (pathname === '/api/visitors/identity/token/current-user') {
    // A BFF's shared egress must not consume the public tracking budget.
    // The handler additionally limits each independently authenticated user.
    return { namespace: 'identity-current-user-admission', limit: 1200, windowSeconds: 60, failClosed: true };
  }
  if (pathname === '/api/status' || pathname.startsWith('/api/status/')) {
    return {
      namespace: 'status',
      limit: 60,
      windowSeconds: 60,
    };
  }
  if (webhookRequest) {
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

export async function limitServiceExpensive(
  request: NextRequest,
): Promise<NextResponse | null> {
  // Only call after verifying the real service credential and apiKeyAuth.
  // All workers/routes/IPs share this identity; never key it by the secret.
  return enforceRequestRateLimit(request, {
    namespace: 'service-expensive',
    identity: 'service-key',
    limit: positiveIntegerSetting('SERVICE_EXPENSIVE_REQUESTS_PER_MINUTE', 600),
    windowSeconds: 60,
    failClosed: true,
  });
}

export async function limitExpensiveGlobal(
  request: NextRequest,
): Promise<NextResponse | null> {
  // Shared by verified internal service and ordinary expensive admission.
  return enforceRequestRateLimit(request, {
    namespace: 'expensive-global',
    identity: 'global',
    limit: positiveIntegerSetting('EXPENSIVE_API_GLOBAL_REQUESTS_PER_MINUTE', 2_000),
    windowSeconds: 60,
    failClosed: true,
  });
}

export async function limitCorsPreflight(
  request: NextRequest,
): Promise<NextResponse | null> {
  // OPTIONS never executes the route. Bound this traffic independently so
  // browser permission checks cannot consume expensive operation budgets.
  const perClient = await enforceRequestRateLimit(request, {
    namespace: 'cors-preflight',
    limit: positiveIntegerSetting('CORS_PREFLIGHT_REQUESTS_PER_MINUTE', 300),
    windowSeconds: 60,
    failClosed: true,
  });
  if (perClient) return perClient;

  return enforceRequestRateLimit(request, {
    namespace: 'cors-preflight-global',
    identity: 'global',
    limit: positiveIntegerSetting(
      'CORS_PREFLIGHT_GLOBAL_REQUESTS_PER_MINUTE',
      10_000,
    ),
    windowSeconds: 60,
    failClosed: true,
  });
}

export async function limitPublicImageDelivery(
  request: NextRequest,
): Promise<NextResponse | null> {
  const perClient = await enforceRequestRateLimit(request, {
    namespace: 'public-image-read',
    limit: positiveIntegerSetting(
      'PUBLIC_IMAGE_READ_REQUESTS_PER_MINUTE',
      300,
    ),
    windowSeconds: 60,
    failClosed: true,
  });
  if (perClient) return perClient;

  return enforceRequestRateLimit(request, {
    namespace: 'public-image-read-global',
    identity: 'global',
    limit: positiveIntegerSetting(
      'PUBLIC_IMAGE_READ_GLOBAL_REQUESTS_PER_MINUTE',
      10_000,
    ),
    windowSeconds: 60,
    failClosed: true,
  });
}
