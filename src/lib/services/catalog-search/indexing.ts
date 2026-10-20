import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EmbeddingsService } from '@/lib/services/embeddings-service';
import { CATALOG_DIMENSIONS, CATALOG_MODEL } from './contract';
import { boundedCatalogEmbeddingInput } from './embedding-input';
export { boundedCatalogEmbeddingInput, CATALOG_EMBEDDING_INPUT_BYTES } from './embedding-input';

const jobSchema = z.object({
  id: z.string().uuid(), catalog_item_id: z.string().uuid(), site_id: z.string().uuid(),
  document_text: z.string().min(1).max(24_000), source_hash: z.string().min(1),
  source_revision: z.union([z.number().int(), z.string().regex(/^\d+$/)]), claim_token: z.string().uuid(),
});

/** Called only by Temporal Activities. All bulky provider output stays out of workflow history. */
export async function processCatalogEmbeddingBatch(limit: number) {
  // Keep worst-case provider+DB waits comfortably below the 180s platform budget,
  // even if a trusted caller requests the API's larger compatibility ceiling.
  const claimLimit = Math.min(limit, 8);
  const refresh = await supabaseAdmin.rpc('catalog_search_refresh_batch', { p_limit: 100 })
    .abortSignal(AbortSignal.timeout(15_000));
  if (refresh.error || !Number.isInteger(refresh.data) || refresh.data < 0 || refresh.data > 100) {
    throw new Error('Catalog lexical refresh failed');
  }
  const refreshed = refresh.data as number;
  const claimed = await supabaseAdmin.rpc('claim_catalog_embedding_jobs', {
    p_limit: claimLimit, p_lease_seconds: 300,
  }).abortSignal(AbortSignal.timeout(10_000));
  if (claimed.error) throw new Error('Catalog index claim failed');
  const jobs = z.array(jobSchema).max(20).parse(claimed.data || []);
  let processed = 0;
  let failed = 0;
  let stale = 0;
  // Two independent documents at a time: a rejected input never poisons its neighbors.
  // Eight claims / two lanes, each 15s provider + 10s CAS + 5s failure <= 130s incl claim.
  for (let start = 0; start < jobs.length; start += 2) {
    const results = await Promise.allSettled(jobs.slice(start, start + 2).map(async job => {
      try {
        const response = await EmbeddingsService.generateEmbeddings(
          boundedCatalogEmbeddingInput(job.document_text), CATALOG_MODEL, CATALOG_DIMENSIONS,
          { timeout: 15_000, signal: AbortSignal.timeout(15_000) },
        );
        if (response.model !== CATALOG_MODEL) throw new Error('Catalog model mismatch');
        const saved = await supabaseAdmin.rpc('complete_catalog_embedding_job', {
          p_job_id: job.id, p_claim_token: job.claim_token,
          p_source_hash: job.source_hash, p_source_revision: job.source_revision,
          p_embedding: `[${response.embeddings[0].join(',')}]`, p_model: CATALOG_MODEL,
        }).abortSignal(AbortSignal.timeout(10_000));
        if (saved.error) throw new Error('Catalog index save failed');
        if (saved.data === true) processed++; else stale++;
      } catch {
        // Controlled category only; do not persist provider input/error bodies.
        const result = await supabaseAdmin.rpc('fail_catalog_embedding_job', {
          p_job_id: job.id, p_claim_token: job.claim_token, p_error: 'embedding_failed',
        }).abortSignal(AbortSignal.timeout(5_000));
        if (result.error) throw new Error('Catalog index failure could not be recorded');
        if (result.data === true) failed++;
      }
    }));
    if (results.some(result => result.status === 'rejected')) throw new Error('Catalog index failure could not be recorded');
  }
  const pending = await supabaseAdmin.rpc('catalog_search_index_pending', {})
    .abortSignal(AbortSignal.timeout(5_000));
  if (pending.error || typeof pending.data !== 'boolean') throw new Error('Catalog backlog state unavailable');
  return { success: true as const, processed, failed, stale, refreshed,
    remaining: pending.data && failed === 0 };
}

export async function backfillCatalogSearch(input: { site_id?: string; after_id?: string; limit: number }) {
  const { data, error } = await supabaseAdmin.rpc('backfill_catalog_search', {
    p_site_id: input.site_id || null, p_after_id: input.after_id || null, p_limit: input.limit,
  }).abortSignal(AbortSignal.timeout(30_000));
  if (error) throw new Error('Catalog backfill failed');
  const rows = z.array(z.object({ catalog_item_id: z.string().uuid() })).max(200).parse(data || []);
  return { success: true as const, processed: rows.length,
    next_cursor: rows.at(-1)?.catalog_item_id || null, has_more: rows.length === input.limit };
}