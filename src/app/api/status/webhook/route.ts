import { NextResponse } from 'next/server';
import { getPublicSummary } from '@/lib/status/get-public-summary';
import { publishSystemStatus } from '@/lib/status/publish-status';

export const dynamic = 'force-dynamic';

/**
 * Public status webhook. Tables stay service_role-only; this route is the
 * HTTP surface. GET returns the last sanitized snapshot. POST re-emits it
 * on Realtime broadcast channel `system-status`.
 */
export async function GET() {
  try {
    const summary = await getPublicSummary();
    return NextResponse.json(summary, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[Status webhook] GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Error loading status' },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    const summary = await getPublicSummary();
    const published = await publishSystemStatus(summary);
    return NextResponse.json(
      { ...summary, published },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[Status webhook] POST error:', error);
    return NextResponse.json(
      { success: false, error: 'Error publishing status' },
      { status: 500 },
    );
  }
}
