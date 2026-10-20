import { z } from 'zod';
import { catalogIndexRequest } from '@/lib/services/catalog-search/index-route';
import { backfillCatalogSearch } from '@/lib/services/catalog-search/indexing';

export const runtime = 'nodejs';
export const maxDuration = 60;
const schema = z.object({
  site_id: z.string().uuid().optional(), after_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

export async function POST(request: Request) {
  return catalogIndexRequest(request, schema, backfillCatalogSearch);
}