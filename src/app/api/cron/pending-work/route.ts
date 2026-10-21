import { NextResponse } from 'next/server';
import { processPendingWorkTick } from '@/lib/services/robot-instance/pending-work';
import { withCronObservation } from '@/lib/status/cron-observation';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

async function runCron(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET?.trim()}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const results = await processPendingWorkTick();
    return NextResponse.json({
      message: `Processed ${results.length} instance queues`,
      results,
    });
  } catch (err: any) {
    console.error('[CronPendingWork] Failed:', err);
    return NextResponse.json({ error: err.message || 'Failed to process pending work' }, { status: 500 });
  }
}

export const GET = withCronObservation('pending-work', runCron);
