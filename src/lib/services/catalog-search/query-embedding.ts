import { z } from 'zod';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai/error';
import { EmbeddingsService, InvalidEmbeddingsResponseError } from '@/lib/services/embeddings-service';
import { OpenRouterConfigurationError } from '@/lib/services/ai/openrouter';
import { CATALOG_DIMENSIONS, CATALOG_MODEL, CATALOG_SEARCH_VERSION } from './contract';
import { acquireCatalogLock, catalogCacheKey, catalogSingleFlight, readCatalogCache,
  releaseCatalogLock, writeCatalogCache } from './cache';
import { CatalogSemanticUnavailableError, type CatalogDegradationReason } from './semantic-errors';

const vectorSchema = z.array(z.number().finite()).length(CATALOG_DIMENSIONS)
  .refine(vector => vector.some(value => value !== 0));
let unavailableUntil = 0;

function embeddingFailureReason(error: unknown, signal: AbortSignal): CatalogDegradationReason {
  if (error instanceof CatalogSemanticUnavailableError) return error.reason;
  if (signal.aborted || error instanceof APIConnectionTimeoutError) return 'embedding_timeout';
  if (error instanceof OpenRouterConfigurationError) return 'embedding_not_configured';
  if (error instanceof InvalidEmbeddingsResponseError || error instanceof z.ZodError || error instanceof SyntaxError) return 'embedding_invalid_response';
  if (error instanceof APIConnectionError) return 'embedding_provider_unavailable';
  // Never copy provider messages, codes, headers, bodies or nested causes into logs.
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (status === 401 || status === 403) return 'embedding_auth_failed';
  if (status === 402) return 'embedding_funding_exhausted';
  if (status === 429) return 'embedding_rate_limited';
  if (status === 408 || status === 504) return 'embedding_timeout';
  if (typeof status === 'number' && Number.isInteger(status) && status >= 500 && status <= 599) return 'embedding_provider_unavailable';
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499) return 'embedding_provider_rejected';
  return 'embedding_failed';
}

export async function getCatalogQueryEmbedding(query: string, scope: string): Promise<number[]> {
  const key = catalogCacheKey('query-vector', {
    query, scope, model: CATALOG_MODEL, dimensions: CATALOG_DIMENSIONS, version: CATALOG_SEARCH_VERSION,
  });
  return catalogSingleFlight(key, async () => {
    const cached = vectorSchema.safeParse(await readCatalogCache(key));
    if (cached.success) return cached.data;
    if (Date.now() < unavailableUntil) throw new CatalogSemanticUnavailableError('embedding_circuit_open');
    const lockKey = `${key}:lock`;
    const lock = await acquireCatalogLock(lockKey);
    if (lock && !lock.acquired) {
      // A concurrent server is already paying for this query. Do not amplify it.
      throw new CatalogSemanticUnavailableError('embedding_lock_contended');
    }
    const signal = AbortSignal.timeout(1_500);
    try {
      const { embeddings, model } = await EmbeddingsService.generateEmbeddings(
        query, CATALOG_MODEL, CATALOG_DIMENSIONS, { timeout: 1_500, signal },
      );
      if (model !== CATALOG_MODEL) throw new CatalogSemanticUnavailableError('embedding_model_mismatch');
      const vector = vectorSchema.parse(embeddings[0]);
      await writeCatalogCache(key, vector, 86_400);
      return vector;
    } catch (error) {
      unavailableUntil = Date.now() + 10_000;
      throw new CatalogSemanticUnavailableError(embeddingFailureReason(error, signal));
    } finally { if (lock?.acquired) await releaseCatalogLock(lockKey, lock.token); }
  });
}