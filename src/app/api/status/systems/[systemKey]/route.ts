import { NextRequest, NextResponse } from 'next/server';
import {
  getPersistedHealthResponse,
  runHealthHandlerResponse,
} from '@/lib/status/health-route-helper';
import {
  enforceRequestRateLimit,
  getAuthenticatedRateIdentity,
  isInternalServiceRequest,
} from '@/lib/security/request-rate-limit';
import {
  acquireLock,
  releaseLock,
} from '@/lib/security/upstash-rest';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ systemKey: string }> },
) {
  const { systemKey } = await context.params;
  const live = request.nextUrl.searchParams.get('live') === '1';
  if (!live) return getPersistedHealthResponse(systemKey);
  if (!isInternalServiceRequest(request)) {
    return NextResponse.json(
      { success: false, error: { code: 'forbidden', message: 'Live checks require a service principal' } },
      { status: 403 },
    );
  }
  const limited = await enforceRequestRateLimit(request, {
    namespace: 'status-live-probe',
    identity: getAuthenticatedRateIdentity(request),
    limit: 6,
    windowSeconds: 60,
    failClosed: true,
  });
  if (limited) return limited;

  const lockKey = `lock:status-live:${systemKey}`;
  const lock = await acquireLock(lockKey, 60);
  if (lock.state === 'contended') {
    return NextResponse.json(
      { success: false, error: { code: 'probe_in_progress', message: 'A live check is already running' } },
      { status: 409, headers: { 'Retry-After': '5' } },
    );
  }
  if (lock.state !== 'acquired') {
    return NextResponse.json(
      { success: false, error: { code: 'admission_unavailable', message: 'Live check admission is unavailable' } },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }
  try {
    return await runHealthHandlerResponse(systemKey, { live: true });
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}
