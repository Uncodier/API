import { z } from 'zod';
import { catalogIndexRequest } from '@/lib/services/catalog-search/index-route';
import { startCatalogIndex } from '@/lib/services/catalog-search/dispatch';

export const runtime = 'nodejs';
const schema = z.object({
  site_id: z.string().uuid().optional(), backfill: z.boolean().default(true),
  after_id: z.string().uuid().optional(),
}).strict();

export async function POST(request: Request) {
  return catalogIndexRequest(request, schema, startCatalogIndex);
}