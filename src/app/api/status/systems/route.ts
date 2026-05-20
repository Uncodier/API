import { NextResponse } from 'next/server';
import { getAllHealthHandlers } from '@/lib/status/handler-registry';
import { getPublicSummary } from '@/lib/status/get-public-summary';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const summary = await getPublicSummary();
    const handlers = getAllHealthHandlers();
    const systems = summary.systems.length
      ? summary.systems
      : handlers.map((h) => ({
          systemKey: h.systemKey,
          label: h.label,
          status: 'unknown',
          summary: 'No probe run yet',
          latencyMs: 0,
          checkedAt: new Date().toISOString(),
          checks: {},
        }));

    return NextResponse.json({
      systems: systems.map((s) => ({
        systemKey: s.systemKey,
        label: s.label,
        status: s.status,
        summary: s.summary,
        latencyMs: s.latencyMs,
        checkedAt: s.checkedAt,
      })),
      lastRunAt: summary.lastRunAt,
      lastTrigger: summary.lastTrigger,
    });
  } catch (err) {
    console.error('[status/systems]', err);
    return NextResponse.json(
      { error: 'Failed to load systems status' },
      { status: 500 },
    );
  }
}
