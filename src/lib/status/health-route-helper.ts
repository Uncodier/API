import { NextResponse } from 'next/server';
import { getHealthHandler } from '@/lib/status/handler-registry';
import { sanitizePublicPayload } from '@/lib/status/types';

const liveCache = new Map<string, { at: number; body: unknown }>();
const CACHE_MS = 5 * 60 * 1000;

export async function runHealthHandlerResponse(
  systemKey: string,
  options: { live?: boolean } = {},
) {
  const handler = getHealthHandler(systemKey);
  if (!handler) {
    return NextResponse.json({ error: 'Unknown system' }, { status: 404 });
  }

  const useCache = !options.live;
  if (useCache) {
    const cached = liveCache.get(systemKey);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return NextResponse.json(cached.body, {
        headers: { 'Cache-Control': 'public, max-age=300' },
      });
    }
  }

  const result = await handler.runCheck({ useCache });
  const body = sanitizePublicPayload(result);
  if (useCache) {
    liveCache.set(systemKey, { at: Date.now(), body });
  }

  const httpStatus = result.status === 'down' ? 503 : result.status === 'degraded' ? 200 : 200;
  return NextResponse.json(body, {
    status: httpStatus,
    headers: { 'Cache-Control': 'no-store' },
  });
}
