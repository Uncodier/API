import { NextResponse } from 'next/server';
import { runProbes } from '@/lib/status/run-probes';
import { sanitizePublicPayload } from '@/lib/status/types';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runProbes('cron_hourly');
    const status = result.overallStatus === 'healthy' ? 200 : 503;
    return NextResponse.json(sanitizePublicPayload(result), { status });
  } catch (err) {
    console.error('[cron/system-status]', err);
    return NextResponse.json(
      {
        error: 'System status probe failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
