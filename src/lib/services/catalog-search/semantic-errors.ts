import { z } from 'zod';

/** Only these application-owned codes may reach catalog logs/snapshots. */
export const catalogDegradationReasonSchema = z.enum([
  'embedding_timeout', 'embedding_not_configured', 'embedding_auth_failed',
  'embedding_funding_exhausted', 'embedding_rate_limited', 'embedding_provider_unavailable',
  'embedding_provider_rejected', 'embedding_invalid_response', 'embedding_model_mismatch',
  'embedding_lock_contended', 'embedding_circuit_open', 'embedding_failed',
  'semantic_retrieval_timeout', 'semantic_retrieval_failed', 'semantic_retrieval_invalid_response',
]);
export type CatalogDegradationReason = z.infer<typeof catalogDegradationReasonSchema>;

export class CatalogSemanticUnavailableError extends Error {
  constructor(readonly reason: CatalogDegradationReason) {
    super(reason === 'embedding_lock_contended'
      ? 'Query embedding is being generated' : 'Semantic search temporarily unavailable');
  }
}