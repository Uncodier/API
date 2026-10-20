import { createHash } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { catalogCacheKey, catalogSingleFlight, readCatalogCache, writeCatalogCache } from './cache';
import { candidateSchema, CATALOG_CANDIDATE_LIMIT, CATALOG_MODEL, CATALOG_SEARCH_VERSION, CATALOG_MIN_SIMILARITY,
  catalogSearchSchema, fuseCatalogCandidates, normalizeCatalogQuery,
  type CatalogCandidate, type CatalogPrincipal, type CatalogSearchInput, type CatalogSearchResult } from './contract';
import { getCatalogQueryEmbedding } from './query-embedding';
import { readCatalogSnapshot, saveCatalogSnapshot, SNAPSHOT_LIFETIME_MS } from './snapshots';
import { catalogDegradationReasonSchema, CatalogSemanticUnavailableError } from './semantic-errors';

const windowSchema = z.object({
  candidates: z.array(candidateSchema).max(CATALOG_CANDIDATE_LIMIT),
  mode: z.enum(['text', 'hybrid']), degraded: z.boolean(),
  degradationReason: catalogDegradationReasonSchema.optional(),
});
type CandidateWindow = z.infer<typeof windowSchema>;
const visibleSchema = z.array(candidateSchema.pick({ id: true, site_id: true })).max(CATALOG_CANDIDATE_LIMIT);

export class CatalogSearchChangedError extends Error {
  constructor() { super('Catalog search changed; restart pagination'); }
}

function windowIdentity(key: string, window: CandidateWindow, ids: string[]): string {
  const hash = createHash('sha256').update(JSON.stringify([key, window.mode, window.degraded, ids])).digest('hex');
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

async function retrieve(input: CatalogSearchInput, mode: 'text' | 'semantic', embedding?: number[]): Promise<CatalogCandidate[]> {
  const signal = AbortSignal.timeout(3_000);
  try {
    const { data, error } = await supabaseAdmin.rpc('catalog_search_candidates', {
      ...rpcScope(input), p_query: input.query, p_mode: mode,
      p_embedding: embedding ? `[${embedding.join(',')}]` : null, p_limit: CATALOG_CANDIDATE_LIMIT,
      p_min_similarity: CATALOG_MIN_SIMILARITY,
    }).abortSignal(signal);
    if (error) throw new Error('Catalog retrieval unavailable');
    return z.array(candidateSchema).max(CATALOG_CANDIDATE_LIMIT).parse(data || []);
  } catch (error) {
    if (mode !== 'semantic') throw error;
    throw new CatalogSemanticUnavailableError(signal.aborted ? 'semantic_retrieval_timeout'
      : error instanceof z.ZodError ? 'semantic_retrieval_invalid_response' : 'semantic_retrieval_failed');
  }
}

async function buildWindow(input: CatalogSearchInput, principal: CatalogPrincipal, semantic: boolean): Promise<CandidateWindow> {
  const textPromise = retrieve(input, 'text');
  // No-query browsing is deliberately not part of this service. Pure codes do not need semantics.
  const exactCode = /^[\p{L}\p{N}._-]+$/u.test(input.query) && /\d/.test(input.query);
  const semanticPromise = semantic && !exactCode
    ? getCatalogQueryEmbedding(input.query, principal.scope).then(vector => retrieve(input, 'semantic', vector))
      .then(candidates => ({ candidates, degraded: false }))
      .catch(error => ({ candidates: [] as CatalogCandidate[], degraded: true,
        degradationReason: error instanceof CatalogSemanticUnavailableError ? error.reason : 'embedding_failed' as const }))
    : Promise.resolve({ candidates: [] as CatalogCandidate[], degraded: false });
  const [text, vector] = await Promise.all([textPromise, semanticPromise]);
  return {
    candidates: fuseCatalogCandidates(text, vector.candidates),
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
    window = snapshot;
    cacheHit = true;
  } else {
    const revision = await revisionFor(input);
    const key = catalogCacheKey('candidates', {
      scope: principal.scope, site: input.site_id, channel: input.channel, filters: input.filters,
      query: input.query, revision, version: CATALOG_SEARCH_VERSION, model: CATALOG_MODEL,
      minSimilarity: CATALOG_MIN_SIMILARITY, semantic,
    });
    window = await catalogSingleFlight(key, async () => {
      const cached = windowSchema.safeParse(await readCatalogCache(key));
      if (cached.success && !cached.data.degraded) { cacheHit = true; return cached.data; }
      const result = await buildWindow(input, principal, semantic);
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
  const ids = window.candidates.map(item => item.id);
  let visible: Array<{ id: string; site_id: string }> = [];
  if (ids.length) {
    const { data, error } = await supabaseAdmin.rpc('catalog_search_visible_ids', {
      ...rpcScope(input), p_ids: ids,
    }).abortSignal(AbortSignal.timeout(2_000));
    if (error) throw new Error('Catalog visibility unavailable');
    visible = visibleSchema.parse(data || []);
  }
  const byId = new Map(visible.map(item => [item.id, item]));
  const current = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  if (input.search_id && current.length !== ids.length) throw new CatalogSearchChangedError();
  const searchId = input.search_id || windowIdentity(stableKey, window, current.map(item => item.id));
  if (!input.search_id) {
    const allowed = new Set(current.map(item => item.id));
    await saveCatalogSnapshot(searchId, { ...window, binding, expiresAt: Date.now() + SNAPSHOT_LIFETIME_MS,
      candidates: window.candidates.filter(item => allowed.has(item.id)) });
  }
  // No query text, vectors, actor IDs, tokens or product contents in logs.
  console.info('[CatalogSearch]', { searchId, channel: input.channel, mode: window.mode,
    degraded: window.degraded, cacheHit, candidates: current.length,
    ...(window.degradationReason ? { degradationReason: window.degradationReason } : {}) });
  return {
    success: true, items: current.slice(input.offset, input.offset + input.limit),
    count: current.length, count_kind: 'candidate_window',
    has_more: input.offset + input.limit < current.length,
    mode: window.mode, degraded: window.degraded, search_id: searchId,
  };
}