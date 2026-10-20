import { createHash, timingSafeEqual } from 'node:crypto';
import { startCatalogIndex } from '@/lib/services/catalog-search/dispatch';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!secret || !timingSafeEqual(digest(request.headers.get('authorization') || ''), digest(`Bearer ${secret}`))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (process.env.CATALOG_INDEXING_ENABLED !== 'true') {
    return Response.json({ success: true, disabled: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    return Response.json(await startCatalogIndex({ backfill: false }), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ success: false, error: 'Catalog workflow dispatch unavailable' }, { status: 503 });
  }
}