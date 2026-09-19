import { NextResponse } from 'next/server';
import { drainRecordingMetadataQueue } from '@/lib/services/session-recording-queue';
import {
  recordTelemetry,
  REDIS_TELEMETRY_KEYS,
} from '@/lib/status/telemetry';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const authHeader = request.headers.get('authorization');
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const start = Date.now();
  try {
    const result = await drainRecordingMetadataQueue();
    await recordTelemetry(
      REDIS_TELEMETRY_KEYS.recordings,
      result.deadLetters > 0 ? 'degraded' : 'up',
      `Recording queue ${result.state}: ${result.chunks} chunks, ${result.deadLetters} dead letters, ${result.remaining} remaining`,
      Date.now() - start,
    );
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('[Session Recording] Queue drain failed:', error);
    await recordTelemetry(
      REDIS_TELEMETRY_KEYS.recordings,
      'down',
      'Recording queue drain failed',
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
