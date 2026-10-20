import { z } from 'zod';
import { EmbeddingsService } from '@/lib/services/embeddings-service';
import { CATALOG_DIMENSIONS, CATALOG_MODEL, CATALOG_SEARCH_VERSION } from './contract';
import { acquireCatalogLock, catalogCacheKey, catalogSingleFlight, readCatalogCache,
  releaseCatalogLock, writeCatalogCache } from './cache';

const vectorSchema = z.array(z.number().finite()).length(CATALOG_DIMENSIONS)
  .refine(vector => vector.some(value => value !== 0));
let unavailableUntil = 0;

export async function getCatalogQueryEmbedding(query: string, scope: string): Promise<number[]> {
  const key = catalogCacheKey('query-vector', {
    query, scope, model: CATALOG_MODEL, dimensions: CATALOG_DIMENSIONS, version: CATALOG_SEARCH_VERSION,
  });
  return catalogSingleFlight(key, async () => {
    const cached = vectorSchema.safeParse(await readCatalogCache(key));
    if (cached.success) return cached.data;
    if (Date.now() < unavailableUntil) throw new Error('Semantic search temporarily unavailable');
    const lockKey = `${key}:lock`;
    const lock = await acquireCatalogLock(lockKey);
    if (lock && !lock.acquired) {
      // A concurrent server is already paying for this query. Do not amplify it.
      throw new Error('Query embedding is being generated');
    }
    try {
      const { embeddings, model } = await EmbeddingsService.generateEmbeddings(
        query, CATALOG_MODEL, CATALOG_DIMENSIONS, { timeout: 1_500, signal: AbortSignal.timeout(1_500) },
      );
      if (model !== CATALOG_MODEL) throw new Error('Unexpected catalog embedding model');
      const vector = vectorSchema.parse(embeddings[0]);
      await writeCatalogCache(key, vector, 86_400);
      return vector;
    } catch {
      unavailableUntil = Date.now() + 10_000;
      throw new Error('Semantic search temporarily unavailable');
    } finally { if (lock?.acquired) await releaseCatalogLock(lockKey, lock.token); }
  });
}