import { NextResponse } from 'next/server';
import { drainTrackingEventQueue } from '@/lib/services/tracking-event-queue';

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

  try {
    const result = await drainTrackingEventQueue();
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('[Tracking Queue] Drain failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown queue error',
      },
      { status: 500 },
    );
  }
}
