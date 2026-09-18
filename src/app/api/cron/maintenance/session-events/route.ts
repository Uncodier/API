import { NextResponse } from 'next/server';
import { runSessionEventRetention } from '@/lib/services/session-event-retention';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const authHeader = request.headers.get('authorization');

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runSessionEventRetention();
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('[SessionEventRetention] Cleanup failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown retention error',
      },
      { status: 500 },
    );
  }
}
