import { NextResponse } from 'next/server';
import { withCronObservation } from '@/lib/status/cron-observation';
import { drainConnectorQueue, queueBudget } from './connector-outbox';
import { deadline } from './cron-control';
import { scanTriggers } from './trigger-scan';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';

async function runCron(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const signal = deadline(req.signal, 770_000);
  const budget = queueBudget();
  // Backlog delivery must not depend on a successful (or fast) trigger scan.
  const [scan] = await Promise.all([scanTriggers(signal), drainConnectorQueue(signal, budget)]);
  // Pick up newly committed reservations without bypassing leases or increasing the tick budget.
  if (scan.counts.reserved && !signal.aborted) await drainConnectorQueue(signal, budget);
  return NextResponse.json({ scan, queue: { acknowledged: budget.queued, failed: budget.failed },
    failed: Number(!scan.complete) + scan.counts.failed + budget.failed + scan.counts.blocked,
  }, { status: scan.complete ? 200 : 503 });
}

export const GET = withCronObservation('workflows', runCron);
