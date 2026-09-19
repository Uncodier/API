import { NextResponse } from 'next/server';
import { drainRecordingMetadataQueue } from '@/lib/services/session-recording-queue';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const authHeader = request.headers.get('authorization');
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await drainRecordingMetadataQueue();
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('[Session Recording] Queue drain failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown queue error',
      },
      { status: 500 },
    );
  }
}
