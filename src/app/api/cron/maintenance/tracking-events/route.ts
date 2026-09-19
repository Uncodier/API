import { NextResponse } from 'next/server';
import { drainTrackingEventQueue } from '@/lib/services/tracking-event-queue';
import {
  recordTelemetry,
  REDIS_TELEMETRY_KEYS,
} from '@/lib/status/telemetry';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (
    !cronSecret
    || request.headers.get('authorization') !== `Bearer ${cronSecret}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const start = Date.now();
  try {
    const result = await drainTrackingEventQueue();
    await recordTelemetry(
      REDIS_TELEMETRY_KEYS.tracking,
      result.deadLetters > 0 ? 'degraded' : 'up',
      `Tracking queue ${result.state}: ${result.events} events, ${result.deadLetters} dead letters, ${result.remaining} remaining`,
      Date.now() - start,
    );
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('[Tracking Queue] Drain failed:', error);
    await recordTelemetry(
      REDIS_TELEMETRY_KEYS.tracking,
      'down',
      'Tracking queue drain failed',
      Date.now() - start,
    );
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown queue error',
      },
      { status: 500 },
    );
  }
}
