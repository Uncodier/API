# Shared related-product fallback

All online catalog search channels (`tools`, `shop`, `marketplace`, `catalog`,
`pos`) use the same retrieval policy. Blank-query browsing and POS offline remain
unchanged; neither calls the embedding provider.

## Retrieval stages

1. Run lexical retrieval (exact names/SKUs, full text, escaped substring, trigram)
   and, when enabled, semantic retrieval at cosine similarity **0.35**.
2. Fuse normal candidates by Reciprocal Rank Fusion, prioritizing exact matches.
3. If the normal window is empty and semantic retrieval succeeded, reuse the same
   query embedding to retrieve at most **five** nearest eligible products at
   similarity **0.25**. Mark them `result_kind: "related"`.
   The same bounded attempt applies when live visibility removes every normal
   candidate before returning the first page. Revalidate those alternatives too.
4. If those candidates are also empty, return an ordinary empty matched result.
   Never use arbitrary nearest neighbors without a relevance floor.

`result_kind` is `matched` or `related` and is independent from `mode` (`text` or
`hybrid`) and provider `degraded` status. Legacy consumers may omit the new field,
which adapters interpret as `matched`; invalid enum values are rejected.
Similarity is not a probability, confidence score or proof of suitability. These
initial thresholds require relevance calibration across languages/categories.

## Safety and UI

- Related results retain the original tenant, channel, query and structured filters.
  Publication, parent availability and channel eligibility are never relaxed.
- Alphanumeric exact codes containing digits keep the existing text-only route.
  They never silently substitute a different code with a related product.
- Provider/model/retrieval failures do not produce fabricated alternatives and
  are not cached as complete successful search results.
- Related results are labeled **Related products/results**, not exact matches.
  Tools must verify required constraints and ask before substituting, booking or
  selling an alternative. A ranking cannot establish dietary or safety claims.
- Candidate caches and immutable two-minute snapshots retain `result_kind`, rank,
  mode and normal overflow evidence. The new search version separates prior caches.
  Snapshot/cache validation caps related windows to five candidates.
- Post-visibility recovery is first-page-only (`offset=0`, no `search_id`) and
  attempted once. Already-attempted related/empty windows, provider degradation,
  text-only/code searches and continuations never trigger another ranking. A lost
  continuation remains a conflict, not a silent replacement. Recovery reuses the
  request's query vector (or lazily loads its normal query cache on a candidate
  cache hit); it pins a snapshot without overwriting the candidate cache associated
  with the pre-change revision. Visibility lookup failures remain fail-closed.
- Online POS preserves existing same-site/local-snapshot gates. Unknown or changed
  suggestions cannot bypass synchronization, price, inventory or modifier rules.

## Filtered semantic recall repair

Apply **`20261020010700_catalog_search_semantic_recall.sql` after migrations
through 10600** before enabling this API/web deployment. No source document or
embedding is rewritten; no backfill is required for the retrieval-only change.
No extension-parameter SET privileges are requested.

The semantic branch materializes eligible, fresh-model documents before exact
distance ordering and the candidate limit. This prevents HNSW's global nearest
neighbors from being discarded by a later site/visibility filter, leaving an
underfilled scoped result. It preserves the RPC signature, grants and lexical SQL.

This exact retrieval trades ANN throughput for filtered correctness: cost grows
linearly with eligible vectors, for site-scoped and global Marketplace queries.
The API client wait deadline remains three seconds per retrieval; that client abort
does not by itself guarantee server-side SQL cancellation. Verify the deployed
PostgREST/database statement timeout and cancellation behavior. Benchmark
actual pgvector in staging before scaling to very large catalogs; HNSW with safe
filtered recall can be reintroduced through a separately validated forward change.

## Mixed-version rollout

On an existing installation, deploy compatible market-fit consumers **before**
the related-producing API. The updated consumers treat older omitted `result_kind`
as `matched`; older consumers instead strip the new classification and can show
related alternatives without labels. Apply only approved missing migrations after
inspecting installed definitions. If an API-first release is necessary, keep
`CATALOG_SEMANTIC_SEARCH_ENABLED=false` until all consumers are compatible. During
rollback, stop related production before reverting the web. No backfill is needed
for this retrieval/visibility repair. Allow in-flight requests and existing
two-minute snapshots to drain before reverting consumers; disabling semantics
does not re-rank or relabel their immutable continuations. See `CATALOG_SEARCH.md`
for initial installs.

## Validation

Run `npm run test:catalog-search` in API and the coordinated offline search test
configuration in market-fit. New regressions cover .332/.317 semantic alternatives,
rejection below .25, cross-site nearer vectors, structured eligibility, five-result
cap, existing matches, exact codes, provider failures, snapshots and consumer labels.
The actual-service/SQL visibility regression removes the last normal match before
the live check and verifies a bounded related response and unchanged continuation.
Local SQL tests substitute pgvector math when unavailable; they do not prove native
vector query latency. No test applies remote migrations, deploys, or reindexes data.