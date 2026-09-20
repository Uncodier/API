import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getHealthHandler } from '@/lib/status/handler-registry';
import { sanitizePublicPayload } from '@/lib/status/types';

const liveCache = new Map<string, { at: number; body: unknown }>();
const CACHE_MS = 5 * 60 * 1000;

export async function getPersistedHealthResponse(systemKey: string) {
  if (!getHealthHandler(systemKey)) {
    return NextResponse.json({ error: 'Unknown system' }, { status: 404 });
  }
  const cached = liveCache.get(systemKey);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json(cached.body, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
    });
  }
  const { data, error } = await supabaseAdmin
    .from('system_status')
    .select('status, summary, latency_ms, health_payload, created_at')
    .eq('system_key', systemKey)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return NextResponse.json(
      { error: 'Status is temporarily unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!data) {
    return NextResponse.json(
      { status: 'unknown', summary: 'No persisted status is available' },
      { status: 404, headers: { 'Cache-Control': 'public, s-maxage=60' } },
    );
  }
  const body = sanitizePublicPayload({
    ...((data.health_payload as Record<string, unknown> | null) ?? {}),
    status: data.status,
    summary: data.summary,
    latencyMs: data.latency_ms,
    checkedAt: data.created_at,
  });
  liveCache.set(systemKey, { at: Date.now(), body });
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
  });
}

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
