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
