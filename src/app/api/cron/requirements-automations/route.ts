import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Retired scheduler endpoint.
 *
 * The canonical requirements-apps cron selects every requirement kind,
 * including automations. Keeping this endpoint read-only prevents legacy
 * callers from acquiring a second execution lock or mutating requirement
 * state while giving operators a clear migration response.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json(
    {
      message: 'Legacy requirements-automations scheduler is retired',
      delegatedTo: '/api/cron/requirements-apps',
    },
    { status: 410 },
  );
}
