import { NextRequest, NextResponse } from 'next/server';
import { getPublicSummary } from '@/lib/status/get-public-summary';
import { runProbes } from '@/lib/status/run-probes';
import { sanitizePublicPayload } from '@/lib/status/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const run = request.nextUrl.searchParams.get('run') === '1';
    const verbose = request.nextUrl.searchParams.get('verbose') === '1';
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET?.trim();

    if (run && authHeader === `Bearer ${cronSecret}` && cronSecret) {
      const result = await runProbes('manual');
      return NextResponse.json(sanitizePublicPayload(result), {
        status: result.overallStatus === 'healthy' ? 200 : 503,
      });
    }

    const summary = await getPublicSummary();

    if (verbose) {
      const serviceKey = request.headers.get('x-api-key');
      const hasServiceKey =
        !!serviceKey &&
        serviceKey === process.env.SERVICE_API_KEY?.trim();
      if (!hasServiceKey) {
        return NextResponse.json({ error: 'Service API key required for verbose' }, { status: 401 });
      }
      return NextResponse.json({
        ...summary,
        verbose: {
          environment: process.env.NODE_ENV,
          vercelUrl: process.env.VERCEL_URL ?? null,
        },
      });
    }

    const httpStatus =
      summary.overall === 'operational'
        ? 200
        : summary.overall === 'down'
          ? 503
          : 200;

    return NextResponse.json(summary, {
      status: httpStatus,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[Status Endpoint] Error:', error);
    return NextResponse.json(
      {
        success: false,
        overall: 'down',
        error: {
          code: 'STATUS_CHECK_ERROR',
          message: 'Error loading status',
        },
      },
      { status: 500 },
    );
  }
}
