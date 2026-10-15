import { dispatchMarketFitWorker } from '@/lib/services/cron/market-fit-dispatch';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return dispatchMarketFitWorker(request, 'marketplace');
}