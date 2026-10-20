# Shared catalog search: SQL contract

Migrations `20261020010000`–`20261020010700` add an index and durable
embedding outbox without modifying original catalog rows. Apply in order through
the normal reviewed deployment process. **Nothing has been applied remotely.**
Failed installations of 10300/10400 should retry their corrected files. Already
installed projects apply 10500 forward: it removes extension GUCs from the existing
function while preserving its owner, grants, security mode and fixed search path.
Word similarity is compared explicitly against 0.5, not through a session-dependent
operator. Through 10600 semantic retrieval used HNSW with deployment search breadth;
10700 replaces that branch with exact filtered cosine retrieval. No extension
parameter SET grants or elevated SQL role are requested.
Migration 10600 raises only the installed candidate RPC guard from 200 to 201;
it checks the expected guard and preserves signature, owner, ACLs, security mode,
search path and retrieval body. Apply it before deploying the overflow-aware API.
No applied migration is edited and no remote migration is run by local validation.
Migration `20261020010700_catalog_search_semantic_recall.sql` must follow 10600.
It guards an exactly-once match of the installed semantic SQL before replacing only
that branch via `pg_get_functiondef`. Unexpected bodies or a missing 201-limit guard
fail closed for manual review; reapplying the exact repaired body is a safe no-op.
Signature, eight arguments, default similarity 0.35, lexical SQL, owner, ACLs,
security mode and search path remain unchanged.

## Prerequisites and ownership

Core catalog tables predate checked-in API migrations. Local consumers/fixtures
confirm these dependencies (verify the real schema before rollout):

- `catalog_items`: `id`, `site_id`, `name`, `description`, `sku`, `metadata`,
  `category_id`, `parent_id`, `kind`, `digital_subtype`, `status`,
  `availability_status`, `availability_mode`, `currency`, commerce booleans.
- `catalog_categories(id,site_id,name)`, `item_specs(id,site_id,name)`,
  `catalog_item_specs(catalog_item_id,item_spec_id)`.
- `sites(id,archived_at)`; there is no assumed `sites.status` column.
- `inventory_levels`, `price_list_items`, `price_lists` have `site_id`.
- Supabase roles `anon`, `authenticated`, `service_role`; `vector` and `pg_trgm`
  extensions must be installed in `public` or `extensions` (created if absent).

All new tables have RLS. No client receives table or function privileges, including
when project default privileges would otherwise grant them. Only service-role
RPCs can publish embeddings or mutate the outbox. The service role can SELECT
job state for polling/health, but not documents, event tables, legacy revisions or direct writes.
Revision reads use the scalar service-role RPC below.
All functions pin `search_path`; helpers have no public/client/service execute grant.
The API must authorize site membership/capability **before** invoking private
channels with its service role. SQL does not impersonate end-user authorization.

## Safe synchronous projection

`catalog_search_documents` has the agreed item FK, site, text, SHA-256 hash,
monotonic source generation, nullable 1536-dimensional vector, model, embedding
source hash, publication timestamp; also normalized name/SKU and generated weighted
`simple` tsvector for retrieval. FK deletion removes documents and jobs.

The semantic document is capped at **6,000 characters**, prioritizing labeled name,
SKU, category name, up to 20 distinct sorted same-site specification names, curated
string attributes, then description. Curated `metadata.attributes` keys are:
`brand`, `material`, `dimensions`, `weight`, `warranty`, `duration`, `level`,
`language`, `format`, `license_type`, `color`, `size`.
Neither arbitrary metadata nor freeform metadata specs, costs, prices, inventory,
URLs, or private spec fields enter the projection. These source fields are presumed
merchant-authored public content; this allowlist is not a secret/PII classifier for
text deliberately put into public names/descriptions/attributes.

Item edits refresh lexical text in their source transaction. Category/spec/link
changes append durable refresh requests without locking child source rows; their
projection becomes current on the next worker drain. Each existing
`claim_catalog_embedding_jobs` call drains at most **100** requests, independently of
the provider embedding claim limit (the API currently claims eight),
before claiming embeddings, including calls with no previously ready embedding jobs.
**Workers must poll periodically even when embedding job health reports zero**, and
resume on the next scheduled poll after a partial/empty batch; a large fanout can
span many polls for callers using only the legacy claim RPC. New workers can call
`catalog_search_refresh_batch(p_limit int) -> integer` (service-role only, 1–100)
before claiming jobs and count the returned drained requests as progress, including
unchanged documents and deleted sources. This allows bounded immediate continuation
through unchanged fanout. `catalog_search_index_pending() -> boolean` (service-role
only) reports refresh requests or claimable embedding jobs; delayed retries, active
leases and exhausted jobs are excluded. All-locked refresh requests can yield
`pending=true` and `refreshed=0`; workers must defer rather than spin without progress.
The legacy claim RPC still drains up to 100 additionally for compatibility. Calling
refresh-batch then claim can therefore process at most **200** requests per API
invocation. Only the explicit first batch's count is exposed as `refreshed`; progress
accounting is conservative if only the claim's implicit batch advances. In that
case a no-embedding/no-explicit-progress response may defer remaining work to the
next periodic poll, never spin unboundedly. Queue lag is
an explicit eventual-consistency limit for relationship-derived text/embeddings,
not for live visibility or item name/SKU edits. Drains delete only processed refresh
requests; locked sources retain requests, deleted sources are discarded.

`source_hash` is SHA-256 of `jsonb_build_array('source-v2-byte7000',normalized_full_name,
normalized_full_sku,bounded_semantic_document)::text`. This unambiguous retrieval
identity prevents identical labeled semantic documents from hiding lexical changes.
Lexical-only changes may regenerate the same semantic embedding harmlessly; no
separate semantic hash is introduced, preserving the existing worker/HNSW validity
contract. The version tag identifies the worker's maximum 7,000-byte UTF-8 input
prefix; edits beyond that prefix may regenerate the same embedding harmlessly.
Changed retrieval hashes (or moved tenants) create a new generation and
clear stale vectors. Unchanged sort-only spec changes and commercial updates do not
re-embed. Run resumable backfill after this migration to upgrade existing hashes;
old hashes/vectors remain self-consistent until each row is refreshed.

Normalized name/SKU preserve their full length (no 1,000/250-character lexical cap).
Their B-tree indexes are fixed-length `md5(lower(field))` expressions, safe for
multibyte 5,000-character names. Exact matching requires **both hash equality and
full lowercased string equality**; MD5 is only an index prefilter, never an identity
or security primitive. Semantic document caps remain unchanged.

## Commit-safe revision RPC

`catalog_search_revision(p_site_id uuid DEFAULT NULL) -> text` returns the exact
scalar string **`events-v1:<visible event count>:<visible maximum event id>`**.
NULL means the global public scope; a UUID filters events to that site. API consumers
must keep the string opaque (no numeric coercion) and authorize private scope first.
Visibility/pricing/inventory/site/source mutations and successful vector publication
append one immutable event per affected site, invalidating the global fingerprint
too. Events roll back atomically with the source/publication transaction.

There is no shared mutable revision row, global advisory lock, or cross-site source
serialization. Sequence IDs are allocation order, **not commit order**: `MAX(id)`
alone misses an earlier ID committed after a later ID. Visible `COUNT(*)` changes
in that case even when MAX does not. Aborted allocations affect neither count nor
max. The legacy `catalog_search_revisions` table remains deprecated and unwritten;
the new `events-v1` token namespace separates it from legacy cache versions.

**Revision events must not be deleted.** They have no cascading source/site FK.
Storage and aggregate-read work grow with invalidations; site indexes constrain
scoped reads, global reads still aggregate all events. Future retention/partition
compaction needs a reviewed epoch/baseline protocol plus cache namespace transition
that preserves late-commit detection. That cleanup is deliberately not implemented.

Existing prebackfill items remain lexical-searchable using safe name/SKU/description
fallback; fresh inserts are immediately lexical even while embeddings are pending.
There is no Redis dependency for correctness.

## Retrieval RPCs

`catalog_search_candidates(p_site_id uuid, p_channel text, p_query text,
p_filters jsonb, p_mode text, p_embedding vector(1536), p_limit integer,
p_min_similarity double precision DEFAULT 0.35)` returns
`(id uuid, site_id uuid, score double precision, exact_match boolean)`.

- Only marketplace permits a NULL site. Query is at most 1,000 characters; blank
  query returns no candidates. Candidate limit is 1–201 after 10600; existing callers
  requesting 200 retain the same SQL results. Mode is `text` or `semantic`.
- Text combines exact SKU/name, weighted `simple` FTS, **literal escaped** substring
  and pg_trgm word similarity. Exact matches sort first. Text score and semantic
  similarity are distinct scales: callers should fuse by rank, not sum raw scores.
- Semantic requires nonzero, 1,536-dimensional query vectors generated with
  **`openai/text-embedding-3-small`**. Only that exact model and a current source hash
  are eligible. Similarity threshold is finite 0–1; include it in cache keys if changed.
  After 10700, an **`eligible AS MATERIALIZED`** CTE selects matching site documents,
  joins the current same-site item, and checks model/source hash plus live shared
  channel/item/parent/site/filter eligibility **before distance ordering or LIMIT**.
  Exact cosine over that relation sorts by distance then item UUID, caps at the
  requested limit (up to 201), and applies the caller's similarity floor. Because
  similarity is monotonic with distance, this returns the complete eligible top K
  above the floor, without HNSW post-filter misses. Global marketplace uses the same
  exact strategy, not a capped ANN approximation or a separate repeated fallback.
  A passed floor of 0.25 admits similarities 0.332/0.317 but excludes 0.1; the SQL
  default remains 0.35. Related/matched labeling and weak nearest-five policy belong
  to the API, not SQL. The API fuses unique eligible rows before returning at most
  200 IDs, emitting `candidate_window_truncated=true` only with more than 200 real
  live-eligible retrieval IDs. Exactly 200 and overlapping retriever rows are not proof.
  This metadata describes the retrieved window, not an exact semantic catalog total:
  exact top K is not a full count beyond the returned limit. Pending, missing or stale
  embeddings remain absent; exact recall cannot repair embedding coverage/quality.
- Allowlisted filter keys: `kind`, `digital_subtype`, `category_id`, `parent_id`,
  `status`, `availability_status`, `currency`, `is_reservation`, `is_purchasable`,
  `is_recurring`, `is_pos_available`, `is_marketplace_listed`. Unknown keys/types
  raise `22023`; booleans must be JSON booleans; IDs accept UUID strings or explicit
  JSON null. Currency is uppercase three-letter text; subtype is 1–80 characters.
- `kind='variant'` means non-null parent. Other kind filters match actual kind;
  only the admin `catalog` channel additionally requires parentless items. Tools and
  POS can find child product/service/digital SKUs; storefront channels enforce their
  own parentless policy independently.
  Unspecified filters do not imply SQL null.

Shared eligibility is used by both candidate modes and
`catalog_search_visible_ids(p_ids uuid[], p_site_id uuid, p_channel text,
p_filters jsonb) -> (id uuid,site_id uuid)`, capped at 400 IDs. Cache consumers must
revalidate returned IDs live and fail closed if revalidation fails.

| Channel | Required eligibility, in addition to same requested site and nonarchived site |
| --- | --- |
| `catalog` | Authorized admin filters; no implicit status default, so omitted status includes archived |
| `tools` | Default active + available item and same-site active + available parent; explicit status/availability filters preserve the authorized legacy administrative override |
| `shop`, `marketplace` | Active, listed, parentless; manual availability must be available; inventory/always modes stay listed even when sold out |
| `pos` | Active and POS flag not explicitly false (legacy null remains allowed), storefront availability, same-site active/POS-eligible/storefront-available parent |

## Durable outbox RPCs

`catalog_embedding_jobs` coalesces one job per item. States:
`pending`, `leased`, `retry`, `done`, `exhausted`. Health polling uses
`pending/retry AND next_attempt_at <= now()` or
`leased AND lease_expires_at <= now()`, excluding exhausted/done.

- `claim_catalog_embedding_jobs(p_limit int,p_lease_seconds int)` accepts 1–100 jobs,
  30–900 second leases; uses `FOR UPDATE SKIP LOCKED` and a fresh UUID token. Returns
  `id,catalog_item_id,site_id,document_text,source_hash,source_revision,claim_token`.
- `complete_catalog_embedding_job(p_job_id,p_claim_token,p_source_hash,
  p_source_revision,p_embedding,p_model) -> boolean`: validates dimensions, nonzero
  vector and canonical model; locks source then validates job token/lease/generation
  and document hash/generation. Returns false for stale, expired, deleted, or already
  completed work. A rapid A→B→A edit cannot resurrect the first A job.
- `fail_catalog_embedding_job(p_job_id,p_claim_token,p_error) -> boolean`: only the
  current unexpired claim can persist retry state. Delay grows exponentially, capped
  at an hour. Only controlled categories `provider_error`, `rate_limited`,
  `invalid_embedding`, `timeout` are retained; other strings become `embedding_failed`
  to avoid persisting provider secrets or raw documents.
- Eight attempts exhaust both explicit failures and crashed-worker expired leases.
  No hourly infinite retry. Source document changes reset the budget automatically.
- `backfill_catalog_search(p_after_id uuid,p_limit int,p_site_id uuid)` accepts 1–500,
  returns ascending `catalog_item_id` rows; next cursor is the maximum returned UUID.
  Re-running unchanged rows is idempotent and never modifies source records. An
  explicit backfill revives exhausted jobs, so operators can repair after fixing a
  provider issue. It does not invalidate done/fresh work or revoke a live lease.
  Busy source rows are skipped rather than waited on and appended to the durable
  refresh queue (including the exhausted-job repair intent); advancing the cursor
  does not lose those rows. Ordinary source multi-row writes can still encounter
  normal PostgreSQL source/source deadlocks and need write-layer retries.

## Offline validation and limits

### Exact semantic performance boundary

The materialization fence removes ANN underfill deliberately. Neither a small-site
shortcut, `hnsw.iterative_scan`, custom extension SET, threshold lowering nor an
oversampling heuristic is used. HNSW's existing index is retained, but this semantic
branch does not order against its base relation and cannot use it for candidate
selection. The pgvector documentation notes that approximate-index filters run
**after** the index scan (e.g. a 10% filter with default `ef_search=40` averages four
matches). Iterative scans can scan more but remain approximate and version-dependent.

Exact distance work grows **O(eligible rows × 1,536 dimensions)**, with materialized
vector memory/temp I/O plus sorting and live eligibility costs. A global marketplace
scope includes all eligible sites; returning only 201 rows does **not** bound rows
scanned. This is a correctness-first choice for current small catalogs, not a claim
of indefinite throughput or low latency at arbitrary marketplace sizes.
The API currently aborts each candidate RPC after three seconds; an HTTP abort is
**not proof of a database statement_timeout/cancellation guarantee**. This migration
does not configure a DB statement timeout. Deployment must verify a suitable server
statement timeout and actual cancellation behavior, not rely on frontend aborts to
bound backend work.

Before increasing volume/concurrency, benchmark **native pgvector** 1,536-dimensional
vectors at representative 104, 390, 4,000 and larger eligible counts, cross-site
selectivity and channel filters. Capture EXPLAIN ANALYZE BUFFERS, p50/p95/p99,
temp I/O and concurrent resource use against the API's three-second RPC budget.
Future partitioning or reviewed bounded ANN strategies must preserve recall and
report approximation explicitly; none is silently introduced here.

Run from the API repo (no credentials/network or remote mutations):

```sh
node --test --test-concurrency=1 __tests__/catalog/catalog-search-sql.test.mjs __tests__/catalog/catalog-search-scale.test.mjs __tests__/catalog/catalog-search-semantic-recall.test.mjs
node --test __tests__/catalog/catalog-search-postgres.test.mjs
node --test __tests__/catalog/catalog-search-visibility.test.mjs
```

The suite executes all eight migrations in ephemeral PGlite with real SQL, FTS and
**real pg_trgm**. PGlite here lacks pgvector: the harness substitutes vector types
with `double precision[]`, supplies SQL cosine distance/negative-dot/array dimension
functions, and omits vector extension creation and HNSW creation. No eligibility,
trigger, lease, retry, grant, or search control-flow SQL is replaced.
The visibility integration test executes the actual TypeScript search service
against those SQL RPCs, making its only normal item unavailable between retrieval
and the final live check. It verifies one related recovery at similarity 0.30,
vector reuse, unchanged candidate-cache classification and pinned continuation.
Transport, embedding provider and cache storage remain offline boundaries.
Run these heavy array-math fixtures serially (`npm run test:catalog-search` does so),
not alongside multiple PGlite workers/typechecks. The six 4,000-vector assertions
exercise SQL substitute cosine repeatedly inside one statement; CPU contention can
hit the local PG harness's eight-second statement deadline. This is a fixture
resource limit, not a native pgvector latency measurement. Assertions and all
4,000 eligible rows remain unchanged; database/lock timeout guards are not relaxed.

This validates permission revocations against permissive default grants, tenant and
channel isolation, filter validation, lexical rollout/refresh, safe projection,
lease fencing/ABA/stale hashes/models, retry exhaustion, cursor repair, cascade
cleanup and transactional rollback, 3,000-byte Unicode names, 5,000-character lexical
fields, ambiguous semantic-vs-lexical changes, variant SKU policy and revision late
visibility. **PGlite does not validate multi-connection races.**
The scale suite also reconstructs a previously installed 200-limit RPC, validates
the forward 10600 repair with identical ACLs/ownership/security, rejects limits over
201, and retrieves 199/200/201 distinct eligible text and semantic candidates.
The 1,500-row fixture proves a real 201st text candidate exists while the unchanged
200-row request remains the prefix. API Jest tests cover unique fusion overlap,
visibility filtering, bounded 402-ID rechecks, pinned cache/snapshot metadata,
overflow-only identity changes and optional legacy snapshot/result types.
The 10700 tests apply the migration to the actual through-10600 function, assert
byte-identical lexical SQL and validation, unchanged signature/default/DTO/ACLs/
ownership/security, no extension SET clauses, safe retry and rejection of unknown
or duplicate branches. A shared SQL fixture runs on PGlite **and real local PG**:
104 above-floor scoped products with 80 closer cross-site vectors, deterministic
top-five ties, 0.332/0.317 at 0.25 versus the unchanged 0.35 default, unrelated 0.1
excluded, model/hash/null-vector/channel/filter/archived-site/live-parent isolation
before a one-row cap, and exact scoped/global 5/200/201 prefixes among 4,000 eligible
vectors. These are correctness assertions using substituted vector math, **not
native pgvector latency/recall benchmarks**.

The real PostgreSQL test creates and tears down its own disposable local Unix-socket
cluster, ignoring connection environment variables and never connecting to an
existing/remote database. It passed on local PostgreSQL 17 with multiple independent
psql sessions: reverse-commit count+max detection, concurrent independent item writes
under a 500ms lock timeout, multi-item edit vs category fanout/backfill, deferred
refresh drain and absence of legacy revision write locks. It skips explicitly if
local unprivileged PostgreSQL 16/17 binaries are unavailable. Local PG lacks pgvector,
so it uses the same explicit vector substitutions as PGlite. **Neither suite validates
pgvector type/input handling or HNSW plans/recall/performance.**

Before production rollout, in a disposable PostgreSQL with the deployed pgvector
version: apply unmodified migrations, EXPLAIN both modes with realistic tenant
selectivity, verify the semantic eligible materialization fence/exact sort, benchmark
as above, and exercise concurrent source, spec and completion transactions. The
10700 branch avoids HNSW filtered recall entirely; iterative-scan tuning is not assumed.
Monitor append-only revision growth/aggregate latency, relationship refresh queue
lag and fanout insertion latency. No revision hot row or synchronous child-row
fanout remains. `FOR NO KEY UPDATE SKIP LOCKED` on background source refresh avoids
waiting on live edits or unnecessarily conflicting with FK key-share locks.
Parent names/variant axes are not inherited into variant documents in this
release; parent eligibility still checks live. Rich metadata/spec text is not a
semantic source.

References read during implementation:
[Supabase database functions](https://supabase.com/docs/guides/database/functions),
[Supabase hybrid search](https://supabase.com/docs/guides/ai/hybrid-search),
[pgvector filtering](https://github.com/pgvector/pgvector#filtering),
[pgvector iterative scans](https://github.com/pgvector/pgvector#iterative-index-scans).