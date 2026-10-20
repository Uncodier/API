import { createHash } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { catalogCacheKey, catalogSingleFlight, readCatalogCache, writeCatalogCache } from './cache';
import { candidateSchema, CATALOG_CANDIDATE_LIMIT, CATALOG_RETRIEVER_PROBE_LIMIT,
  CATALOG_MODEL, CATALOG_SEARCH_VERSION, CATALOG_MIN_SIMILARITY,
  CATALOG_RELATED_MIN_SIMILARITY, CATALOG_RELATED_LIMIT,
  catalogSearchSchema, fuseCatalogCandidates, normalizeCatalogQuery,
  type CatalogCandidate, type CatalogPrincipal, type CatalogSearchInput, type CatalogSearchResult } from './contract';
import { getCatalogQueryEmbedding } from './query-embedding';
import { readCatalogSnapshot, saveCatalogSnapshot, SNAPSHOT_LIFETIME_MS } from './snapshots';
import { catalogDegradationReasonSchema, CatalogSemanticUnavailableError } from './semantic-errors';

const windowSchema = z.object({
  candidates: z.array(candidateSchema).max(CATALOG_RETRIEVER_PROBE_LIMIT * 2),
  mode: z.enum(['text', 'hybrid']), degraded: z.boolean(),
  candidate_window_truncated: z.boolean().optional(),
  result_kind: z.enum(['matched', 'related']).default('matched'),
  degradationReason: catalogDegradationReasonSchema.optional(),
}).refine(window => window.result_kind !== 'related' || (window.candidates.length <= CATALOG_RELATED_LIMIT
  && window.mode === 'hybrid' && !window.degraded && !window.candidate_window_truncated));
type CandidateWindow = z.infer<typeof windowSchema>;
const VISIBLE_BATCH_LIMIT = 400;
const visibleSchema = z.array(candidateSchema.pick({ id: true, site_id: true })).max(VISIBLE_BATCH_LIMIT);

export class CatalogSearchChangedError extends Error {
  constructor() { super('Catalog search changed; restart pagination'); }
}

function windowIdentity(key: string, window: CandidateWindow, ids: string[]): string {
  const hash = createHash('sha256').update(JSON.stringify([
    key, window.mode, window.degraded, window.result_kind, window.candidate_window_truncated ?? false, ids,
  ])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function revisionFor(input: CatalogSearchInput): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc('catalog_search_revision', {
    p_site_id: input.site_id || null,
  }).abortSignal(AbortSignal.timeout(2_000));
  if (error) throw new Error('Catalog revision unavailable');
  if (typeof data !== 'string') throw new Error('Invalid catalog revision');
  return data;
}

function rpcScope(input: CatalogSearchInput) {
  return { p_site_id: input.site_id || null, p_channel: input.channel, p_filters: input.filters };
}

async function retrieve(input: CatalogSearchInput, mode: 'text' | 'semantic', embedding?: number[],
  minimumSimilarity = CATALOG_MIN_SIMILARITY, limit = CATALOG_RETRIEVER_PROBE_LIMIT): Promise<CatalogCandidate[]> {
  const signal = AbortSignal.timeout(3_000);
  try {
    const { data, error } = await supabaseAdmin.rpc('catalog_search_candidates', {
      ...rpcScope(input), p_query: input.query, p_mode: mode,
      p_embedding: embedding ? `[${embedding.join(',')}]` : null, p_limit: limit,
      p_min_similarity: minimumSimilarity,
    }).abortSignal(signal);
    if (error) throw new Error('Catalog retrieval unavailable');
    return z.array(candidateSchema).max(limit).parse(data || []);
  } catch (error) {
    if (mode !== 'semantic') throw error;
    throw new CatalogSemanticUnavailableError(signal.aborted ? 'semantic_retrieval_timeout'
      : error instanceof z.ZodError ? 'semantic_retrieval_invalid_response' : 'semantic_retrieval_failed');
  }
}

async function relatedWindow(input: CatalogSearchInput, embedding: () => Promise<number[]>): Promise<CandidateWindow> {
  try {
    const related = await retrieve(input, 'semantic', await embedding(), CATALOG_RELATED_MIN_SIMILARITY, CATALOG_RELATED_LIMIT);
    return { candidates: related, mode: 'hybrid', degraded: false,
      result_kind: related.length ? 'related' : 'matched' };
  } catch (error) {
    return { candidates: [], mode: 'text', degraded: true, result_kind: 'matched',
      degradationReason: error instanceof CatalogSemanticUnavailableError ? error.reason : 'embedding_failed' };
  }
}

async function visibleCandidates(input: CatalogSearchInput, candidates: CatalogCandidate[]) {
  const ids = candidates.map(item => item.id);
  const visible: Array<{ id: string; site_id: string }> = [];
  // Fusion can contain 402 unique IDs. Keep the existing SQL visibility bound of 400.
  for (let offset = 0; offset < ids.length; offset += VISIBLE_BATCH_LIMIT) {
    const { data, error } = await supabaseAdmin.rpc('catalog_search_visible_ids', {
      ...rpcScope(input), p_ids: ids.slice(offset, offset + VISIBLE_BATCH_LIMIT),
    }).abortSignal(AbortSignal.timeout(2_000));
    if (error) throw new Error('Catalog visibility unavailable');
    visible.push(...visibleSchema.parse(data || []));
  }
  const byId = new Map(visible.map(item => [item.id, item]));
  return ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
}

async function buildWindow(input: CatalogSearchInput, semantic: boolean, embedding: () => Promise<number[]>): Promise<CandidateWindow> {
  const textPromise = retrieve(input, 'text');
  // No-query browsing is deliberately not part of this service. Pure codes do not need semantics.
  const exactCode = /^[\p{L}\p{N}._-]+$/u.test(input.query) && /\d/.test(input.query);
  const semanticPromise = semantic && !exactCode
    ? embedding().then(vector => retrieve(input, 'semantic', vector))
      .then(candidates => ({ candidates, degraded: false }))
      .catch(error => ({ candidates: [] as CatalogCandidate[], degraded: true,
        degradationReason: error instanceof CatalogSemanticUnavailableError ? error.reason : 'embedding_failed' as const }))
    : Promise.resolve({ candidates: [] as CatalogCandidate[], degraded: false });
  const [text, vector] = await Promise.all([textPromise, semanticPromise]);
  const candidates = fuseCatalogCandidates(text, vector.candidates);
  // Alternative discovery is explicit, bounded and preserves the original query,
  // filters and authorization. Do not invent matches on provider failures or codes.
  if (!candidates.length && semantic && !exactCode && !vector.degraded) {
    return relatedWindow(input, embedding);
  }
  return {
    candidates, result_kind: 'matched', candidate_window_truncated: candidates.length > CATALOG_CANDIDATE_LIMIT,
    mode: semantic && !exactCode && !vector.degraded ? 'hybrid' : 'text', degraded: vector.degraded,
    ...('degradationReason' in vector ? { degradationReason: vector.degradationReason } : {}),
  };
}

/** Internal callers must resolve their authorization before providing a cache principal. */
export async function searchCatalog(rawInput: unknown, principal: CatalogPrincipal): Promise<CatalogSearchResult> {
  const input = catalogSearchSchema.parse(rawInput);
  input.query = normalizeCatalogQuery(input.query);
  if (!principal.scope) throw new Error('Catalog principal is required');
  const semantic = process.env.CATALOG_SEMANTIC_SEARCH_ENABLED === 'true';
  // Reuse one request-local vector, including the bounded post-visibility recovery.
  // Cache hits load it lazily only if all normal candidates become ineligible.
  let queryEmbedding: Promise<number[]> | undefined;
  const embedding = () => queryEmbedding ??= getCatalogQueryEmbedding(input.query, principal.scope);
  const binding = catalogCacheKey('snapshot-binding', {
    scope: principal.scope, site: input.site_id, channel: input.channel, filters: input.filters,
    query: input.query, version: CATALOG_SEARCH_VERSION, model: CATALOG_MODEL,
  });
  let window: CandidateWindow;
  let cacheHit = false;
  let stableKey = binding;
  if (input.search_id) {
    const snapshot = await readCatalogSnapshot(input.search_id, binding);
    if (!snapshot) throw new CatalogSearchChangedError();
    window = { ...snapshot, result_kind: snapshot.result_kind || 'matched' };
    cacheHit = true;
  } else {
    const revision = await revisionFor(input);
    const key = catalogCacheKey('candidates', {
      scope: principal.scope, site: input.site_id, channel: input.channel, filters: input.filters,
      query: input.query, revision, version: CATALOG_SEARCH_VERSION, model: CATALOG_MODEL,
      minSimilarity: CATALOG_MIN_SIMILARITY, relatedMinSimilarity: CATALOG_RELATED_MIN_SIMILARITY,
      relatedLimit: CATALOG_RELATED_LIMIT, semantic, probeLimit: CATALOG_RETRIEVER_PROBE_LIMIT,
    });
    window = await catalogSingleFlight(key, async () => {
      const cached = windowSchema.safeParse(await readCatalogCache(key));
      if (cached.success && !cached.data.degraded) { cacheHit = true; return cached.data; }
      const result = await buildWindow(input, semantic, embedding);
      // Never label a provider failure as a complete negative/hybrid cache entry.
      if (!result.degraded && await revisionFor(input) === revision) {
        await writeCatalogCache(key, result, result.candidates.length ? 45 : 8);
      }
      return result;
    });
    // A concurrent update only prevents caching, not a usable live-checked response.
    // Never loop until the entire global marketplace becomes immobile.
    stableKey = key;
  }
  let eligible = await visibleCandidates(input, window.candidates);
  if (input.search_id && eligible.length !== window.candidates.length) throw new CatalogSearchChangedError();
  // Only recover a normal first page emptied by live visibility, never an expired
  // continuation or an already-attempted related/empty window. No retry loop.
  if (!input.search_id && input.offset === 0 && semantic && window.mode === 'hybrid' && !window.degraded
    && window.result_kind === 'matched' && window.candidates.length > 0 && !eligible.length) {
    window = await relatedWindow(input, embedding);
    eligible = await visibleCandidates(input, window.candidates);
    // This recovery is request-local: do not overwrite a candidate cache using
    // the revision captured before the eligibility change. Pin only the snapshot.
  }
  // Continuations retain the original evidence, even after the probe falls outside the snapshot.
  const truncated = input.search_id ? window.candidate_window_truncated ?? false
    : eligible.length > CATALOG_CANDIDATE_LIMIT;
  window = { ...window, candidate_window_truncated: truncated };
  const current = eligible.slice(0, CATALOG_CANDIDATE_LIMIT);
  const searchId = input.search_id || windowIdentity(stableKey, window, current.map(item => item.id));
  if (!input.search_id) {
    const allowed = new Set(current.map(item => item.id));
    await saveCatalogSnapshot(searchId, { ...window, binding, expiresAt: Date.now() + SNAPSHOT_LIFETIME_MS,
      candidates: window.candidates.filter(item => allowed.has(item.id)) });
  }
  // No query text, vectors, actor IDs, tokens or product contents in logs.
  console.info('[CatalogSearch]', { searchId, channel: input.channel, mode: window.mode,
    degraded: window.degraded, cacheHit, candidates: current.length,
    result_kind: window.result_kind,
    ...(window.degradationReason ? { degradationReason: window.degradationReason } : {}) });
  return {
    success: true, items: current.slice(input.offset, input.offset + input.limit),
    count: current.length, count_kind: 'candidate_window',
    candidate_window_truncated: truncated,
    result_kind: window.result_kind,
    has_more: input.offset + input.limit < current.length,
    mode: window.mode, degraded: window.degraded, search_id: searchId,
  };
}