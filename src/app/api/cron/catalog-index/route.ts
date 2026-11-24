import { createHash, timingSafeEqual } from 'node:crypto';
import { startCatalogIndex } from '@/lib/services/catalog-search/dispatch';
import { observeCatalogIndexQueue } from '@/lib/services/catalog-search/queue-observation';
import { withCronObservation } from '@/lib/status/cron-observation';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function runCron(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!secret || !timingSafeEqual(digest(request.headers.get('authorization') || ''), digest(`Bearer ${secret}`))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (process.env.CATALOG_INDEXING_ENABLED !== 'true') {
    return Response.json({ success: true, disabled: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const observation = observeCatalogIndexQueue().catch(() => {
    console.warn('[Catalog index queue] observation unavailable');
  });
  try {
    // Source changes enqueue their own work. Full scans must be requested explicitly.
    return Response.json(await startCatalogIndex({ backfill: false }), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ success: false, error: 'Catalog workflow dispatch unavailable' }, { status: 503 });
  } finally {
    await observation;
  }
}

export const GET = withCronObservation('catalog-index', runCron);