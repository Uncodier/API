import { dispatchMarketFitWorker } from '@/lib/services/cron/market-fit-dispatch';
import { withCronObservation } from '@/lib/status/cron-observation';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

async function runCron(request: Request) {
  return dispatchMarketFitWorker(request, 'credit-auto-top-up');
}

export const GET = withCronObservation('credit-auto-top-up', runCron);