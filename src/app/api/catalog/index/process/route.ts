import { z } from 'zod';
import { catalogIndexRequest } from '@/lib/services/catalog-search/index-route';
import { processCatalogEmbeddingBatch } from '@/lib/services/catalog-search/indexing';

export const runtime = 'nodejs';
export const maxDuration = 180;
const schema = z.object({ limit: z.number().int().min(1).max(20).default(8) }).strict();

export async function POST(request: Request) {
  return catalogIndexRequest(request, schema, input => processCatalogEmbeddingBatch(input.limit));
}