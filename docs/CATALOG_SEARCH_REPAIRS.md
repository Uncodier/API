# Catalog search review repairs

The forward repair migration is `20261020010400_catalog_search_repairs.sql`.
The later compatibility migration is `20261020010500_catalog_search_parameter_permissions.sql`.
Failed 10300/10400 installations can retry corrected files without restricted
extension SET clauses; already-installed projects use 10500 forward. No remote
migration/backfill was executed by this coding task.

| Review finding | Repair | Regression evidence |
| --- | --- | --- |
| Revision/source lock inversion | Append-only transactional revision events; relationship requests never lock child rows; backfill/refresh skip busy rows and defer durably | Independent PostgreSQL sessions for concurrent source edits, category fanout and backfill |
| Multibyte B-tree overflow | Fixed-size hash equality indexes with full-string collision recheck; full normalized lexical fields | Long Unicode names/SKUs insert, update and backfill successfully |
| Revision churn makes searches fail | A revision change suppresses cache publication, not the response; live ID eligibility still checked | Search completes once under changing revision fingerprints |
| Invalid document poisons batch | Independent per-document embedding calls, two lanes, conservative UTF8 byte budget | One rejected input fails only itself; three neighbors complete |
| Scoped API keys rejected | Verify raw database credential; recheck current scope, expiry, revocation, site and effective owner access | x-api-key and bearer API keys, invalid/wrong-tenant/scope/revoked/expired cases |
| Tool kind hides variant SKU | Tool type filters no longer imply parentless rows; channel-specific policies remain | Product kind returns child SKU in SQL and tools hydration |
| Shop fulfillment metadata lost | Preserve validated public delivery/payment options without arbitrary metadata | Search DTO passed through actual fulfillment/cart helpers |
| UI pages silently mix rankings | Request-bound two-minute candidate snapshots; Catalog/Marketplace retain expected ID and restart on 409 | Actual UI page navigation/provider recovery/expiry regressions |
| Prices differ between filtering/display | Mandatory item-ID batching and pagination for all sizes; price-list ownership checks | 201 candidates plus 1000 unrelated overrides, actual Marketplace filter/sort/display |
| Ambiguous text hash leaves name/SKU stale | Versioned structured hash over normalized independent lexical fields and semantic document | X SKU: Y / null becomes X / Y and exact matching updates |
| BFF users share generic egress quota | Verified service catalog requests use existing service/global admission path, then per-client handler admission | 301 distinct shopper buckets on one egress pass; unverified bucket cannot bypass auth |

## Verification commands

API: `npm run test:catalog-search`. This includes no-environment Jest tests, real
PGlite FTS/pg_trgm/ACL/queue tests, a 1500-product smoke test and a disposable local
PostgreSQL multi-session test. The latter explicitly skips if unprivileged local
PostgreSQL binaries are unavailable. It never connects using developer PG settings.

Workflows: `node node_modules/jest/bin/jest.js --runInBand
tests/catalog-index-workflow.test.ts tests/catalog-index-activities.test.ts
tests/catalog-index-registration.test.ts`.

market-fit: `node node_modules/jest/bin/jest.js --config
jest.catalog-offline.config.cjs --runInBand`. This bypasses Next configuration and
dotenv. Typecheck coordinated repositories separately before deployment.

## Operational boundaries

- Relationship search text is eventually consistent until the Temporal refresh
  drain; item name/SKU edits remain synchronous. `refreshed` progress lets a
  lexical-only backlog advance without requiring an embedding to be produced.
- Snapshot rank/mode is immutable, but current visibility, price and inventory are
  not. Removed/ineligible candidates invalidate continuation rather than shifting
  offsets silently. A lost cross-instance snapshot returns 409, never a new ranking.
- Revision events must not be deleted. Count plus maximum committed event ID detects
  reverse commit order, unlike maximum sequence ID alone. Event compaction and
  aggregate-read scaling require a future commit-safe protocol.
- Real local PostgreSQL validates locking/state SQL, but substitutes pgvector math
  and omits HNSW. Actual vector indexes, filtered recall and production latency still
  require staging verification.
- Competing ordinary source transactions can still deadlock independently of search;
  application transaction retry policy remains a separate concern.