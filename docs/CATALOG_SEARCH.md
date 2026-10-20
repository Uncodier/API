# Shared catalog search and Temporal indexing

## Boundaries

The API owns retrieval, query-vector/result caches, authorized search policies and
embedding Activities' HTTP implementation. `Workflows` owns `catalogIndexWorkflow`.
`market-fit` owns current-price/inventory hydration and presentation for Shop,
Marketplace, administrative Catalog and POS. Agent `catalog_commerce` uses the same
retrieval service. No product vectors or full catalog records enter workflow history.

Search is not checkout authorization. Always revalidate the selected item's price,
inventory, parent eligibility and purchasing rules at quote/order/reservation time.
POS local snapshots remain available without the API or an embedding provider.

## Database rollout

Apply the six migrations in order, after inspecting the destination:

1. `20261020010000_catalog_search_documents.sql`
2. `20261020010100_catalog_search_refresh.sql`
3. `20261020010200_catalog_embedding_outbox.sql`
4. `20261020010300_catalog_search_candidates.sql`
5. `20261020010400_catalog_search_repairs.sql`
6. `20261020010500_catalog_search_parameter_permissions.sql`

The fourth and fifth files also omit extension parameter SET clauses so failed
installations can retry them using the normal Supabase migration role. The sixth
repairs already-installed functions without expanding parameter privileges.
The fifth removes mutable revision-row
locking, introduces asynchronous relationship refresh requests, replaces potentially
oversized B-tree keys with collision-checked hash equality indexes, and versions
structured source hashes. Always apply the repair before allowing source writes or
starting a backfill with this deployment.
If the fourth failed inside its transaction, roll back any still-aborted SQL
session and rerun the corrected fourth, then fifth and sixth; do not replay 1–3.
The explicit word-similarity cutoff remains 0.5 regardless of session settings.
HNSW uses deployment defaults; tune only after verifying the installed extension
and permitted settings. No GRANT SET ON PARAMETER or superuser is required here.

These require the existing commerce tables and `vector` plus `pg_trgm` installed in
`public` or `extensions`. Tables use RLS and service-role-only grants. The public
search-facing RPCs are **not** granted to anonymous or authenticated database roles;
the API verifies credentials and current site access before invoking them.
Private bearer access also requires the existing `site_user_has_effective_access`
authorization RPC from the coordinated market-fit site-access migrations.

Migrations do not call providers or rewrite catalog source rows. Existing rows can
be found lexically before the resumable backfill; newly changed rows refresh their
search document and outbox entry in the source transaction. Category and spec/link
changes enqueue append-only refresh requests; Temporal drains them without waiting
on busy source rows. Their projection is eventually consistent until polling.
Visibility, inventory and pricing changes
invalidate candidate caches without unnecessarily regenerating product vectors.

The semantic document is a capped, curated projection of public name, SKU,
description, category, spec names and known attributes. Costs, prices, inventory,
customer data and arbitrary metadata are not embedding input. The product embedding
model is pinned to `openai/text-embedding-3-small`, 1536 dimensions. Model/document
schema changes require a forward migration, cache version change and reindex plan;
do not mix vector spaces.

## Deployment order and configuration

1. Validate migrations in staging, including actual pgvector queries and HNSW plans.
2. Apply approved migrations; deploy API and the registered Temporal worker.
3. Deploy market-fit consumers against the same API/Supabase environment. There is
   no silent return to divergent local `ILIKE` when the shared endpoint fails.
4. Set `CATALOG_INDEXING_ENABLED=true` in API to enable the checked-in minute cron.
   Each tick starts/reuses `catalog-index-backfill:all` with `backfill: true`.
   Temporal scans existing products before draining jobs; the cron itself never
   generates embeddings. Unchanged indexed documents are reused, but each scan
   can revive exhausted jobs, so monitor persistent failures and provider cost.
5. The initial backfill now starts automatically on the first enabled tick after
   deployment. Service-authenticated `POST /api/catalog/index/start` remains
   available for manual/site-scoped runs. Indexing incurs embedding-provider usage;
   local tests do not execute paid backfills.
6. Inspect indexing coverage, retries/exhausted jobs, cost and real relevance.
7. Set `CATALOG_SEMANTIC_SEARCH_ENABLED=true` in API when ready. Until then shared
   retrieval remains lexical (exact SKU/name, FTS, escaped substring, trigram).

Existing configuration is reused: `OPENROUTER_API_KEY`, Supabase server credentials,
`SERVICE_API_KEY`, `CRON_SECRET`, Temporal connection settings and
`WORKFLOW_TASK_QUEUE` (default `default`). Public market-fit channels send the
service credential server-to-server only. Private channels send a verified session
bearer. Never expose the service credential in browser code or example requests.
Current database API keys with `read` or `*` scope are also accepted for their
explicit site only. Revocation, expiry, scopes and effective owner access are
rechecked before catalog-cache access; forged middleware identity headers do not
establish authentication.
Public BFF requests may include a server-derived `x-catalog-client-id` (64 hex
characters). It is used for shopper admission only **after** the service credential
is independently verified, never as authorization or cache scope. Bearer users have
separate hashed user admission buckets even when sharing public candidate caches.
Without a trusted shopper bucket, service requests use the aggregate service budget.

Redis uses `REDIS_CACHE_URL`, falling back to explicitly configured `REDIS_URL`.
No implicit localhost cache is used. Prefer a separate evictable cache deployment,
not the durable streams database. Redis is optional for correctness, not for
capacity planning: an outage can increase database/provider demand.

## Search contract

`POST /api/catalog/search` requires a service credential or independently verified
Supabase bearer. Private channels require current site access. Identity headers
alone are not accepted. Request fields:

- `query`: nonempty, at most 200 characters; conservative NFC/whitespace normalization.
- `channel`: `tools`, `shop`, `marketplace`, `catalog` or `pos`.
- `site_id`: required except a global public Marketplace search.
- `filters`: strictly allowlisted catalog fields; nullable category/parent IDs mean
  `IS NULL`. Channel visibility rules cannot be bypassed using filters.
- `limit`: integer 1–100; `offset`: integer 0–200.
- `search_id`: optional prior result window ID. Continuations reuse a bounded
  two-minute immutable candidate snapshot, including its original text/hybrid mode.
  A missing/expired snapshot, changed request binding or changed eligible ID set
  returns 409 so consumers restart instead of silently mixing candidate orders.

Results contain IDs/site IDs, `count`, `count_kind: "candidate_window"`, `has_more`,
`mode`, `degraded` and `search_id`. The bounded fused window has at most 200 candidates:
**count is not an exact total of semantic matches**. Blank-query browsing stays in
existing database-paginated listing paths and does not generate query embeddings.

Exact alphanumeric codes containing digits use textual search without a provider
call. Other queries retrieve lexical and semantic candidates concurrently when
enabled. Reciprocal Rank Fusion combines positions and prioritizes exact matches.
Semantic cosine similarity has an initial 0.35 floor; this is a calibration starting
point, not a probability or a measured quality guarantee. Search prompt policies
preserve constraints and negations rather than deleting intent into 1–2 keywords.

## Cache and freshness

- Product vectors persist in pgvector; they are not copied wholesale to Redis.
- Query vectors: 24-hour TTL with jitter; key includes authorized scope, normalized
  input hash, canonical model, dimensions and version. A catalog change does not
  invalidate a query's embedding.
- Candidate windows: 45-second TTL with jitter; empty windows 8 seconds. Keys include
  authorized scope, site, channel, filters, query, catalog/index revision, model,
  similarity threshold and search version. Prices and complete records are not cached.
- Live revisions are read through `catalog_search_revision`, an opaque count+max
  fingerprint over committed append-only events. A sequence alone is not commit
  ordered. A change during retrieval prevents candidate-cache writes but does not
  prevent a live-checked response or require the global catalog to stop changing.
  Cache hits and continuations still recheck current eligible IDs. Snapshots bind
  tenant/principal, query, filters and channel; Redis supports cross-instance
  continuity, with a bounded local fallback. Missing storage never causes re-ranking.
  This is not a transactionally frozen checkout snapshot.
- Process-local single-flight bounds concurrent identical work. Short owner-token
  Redis locks suppress duplicate query-embedding calls across servers. Lock
  contention falls back to text; it is not proof that a cached vector exists.
- Redis operations have a short request wait budget. Provider errors/timeouts fall
  back to textual search with `degraded=true` and are not cached as complete results.
  Never silently retry embeddings using a different model/account.

## Temporal/worker API

These POST endpoints verify the raw service credential independently:

- `/api/catalog/index/start`: starts/reuses workflow, `{site_id?, backfill?, after_id?}`.
- `/api/catalog/index/backfill`: processes one cursor page, `{site_id?, after_id?, limit?}`.
- `/api/catalog/index/process`: claims and processes a bounded batch, `{limit?}`.

The process endpoint claims a 300-second database lease and embeds each document
independently with two concurrent lanes (at most eight claims per invocation).
One provider-rejected document cannot exhaust valid neighboring jobs. Inputs use
a conservative 7,000 UTF-8-byte ceiling without splitting codepoints; the structured
source hash versions that projection. Completion matches claim token/hash/revision. Failed
work records a controlled error category, not raw upstream request/response bodies.
Temporal retries cannot bypass these guards. Expired claims are recoverable; source
edits revoke stale claims. Durable retries/backoff/exhaustion are enforced in SQL.
The endpoint explicitly drains up to 100 lexical refresh requests and reports
`refreshed`; the compatibility claim RPC can drain another 100. `remaining` includes
ready refresh/embedding work, but not delayed retries, live leases or exhausted jobs.
Temporal recognizes lexical-only progress and yields when nothing can advance.
The periodic dispatcher resumes ready work, including delayed retries. A backfill
and a normal drain can coexist safely because the database claims jobs atomically.

## Validation and remaining production checks

Local unit command: `node node_modules/jest/bin/jest.js --config jest.catalog-search.config.js --runInBand`.
SQL tests are under `__tests__/catalog/catalog-search-sql.test.mjs`; execute with
`node --test __tests__/catalog/catalog-search-sql.test.mjs`.
`npm run test:catalog-search` also runs the 1,500-product bounded retrieval smoke test.

The SQL harness uses real PGlite SQL/FTS/pg_trgm/ACLs with substituted vector
operators and no HNSW index. A separate disposable local PostgreSQL test uses
independent sessions for reverse commits, source updates and fanout/backfill locking
(or explicitly skips if local binaries are unavailable). It **does not** prove
pgvector planner behavior or production latency. Before enabling semantic search:

- Check actual extension versions, HNSW filtered recall and `EXPLAIN ANALYZE` on
  representative per-site/global catalog sizes (including selective filters).
- Measure P50/P95 latency, cache hit rate, degraded search rate, embedding cost,
  indexing lag and recall for exact SKUs, typos, multilingual intent and no matches.
- Check cross-site isolation, newly hidden/deleted parents and stale stock/price
  transitions through each consumer, including POS offline/online reconnection.
- Benchmark append-only event growth and relationship-refresh throughput. Revision
  events must not be deleted: commit-safe compaction is a separate future protocol.
  Ordinary competing source writes still require transaction retry policies; the
  search index no longer introduces a shared revision-row lock inversion.
- Marketplace blank-query commercial ranking retains its existing loader. This
  change bounds query search; it is not a rewrite of all homepage ranking work.

No local test deploys services, applies remote migrations, generates paid vectors,
creates remote schedules, or runs a production backfill.