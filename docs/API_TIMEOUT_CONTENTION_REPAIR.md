# API timeout contention mitigation (local, 2026-11-14)

## Evidence and scope

Confirmed production errors reached installed RPCs: requirement claim timed out
inside `recheck_requirement_economic_pauses` at `UPDATE checked_at`; catalog
backfill timed out inside `refresh_catalog_search_document` at the document
upsert. Missing migration history is not evidence that either RPC is absent.
The parent investigation inspected remote RPC definitions and migration history;
no historical lock graph or execution plans identified the production blocker.
The exact production blocking transaction / CPU / I/O
root cause therefore remains unresolved. These repairs mitigate reproduced lock
contention, not every possible statement timeout.

Read the complete recovery function in `20261026030000`, claim wrapper in
`20261026020000`, recovery dependencies and catalog refresh/backfill/outbox
functions. The canonical DEVELOPMENT, ARCHITECTURE, SECURITY,
DATABASE_MIGRATIONS and MAINTENANCE documents named in repository guidance are
absent in this checkout; AGENTS, docs/README, catalog operational guides and the
installed Next route-handler guide were read instead.

## Existing concurrency and batches

- Requirement cron: sequential claim RPCs, default eight concurrent runs, default
  100 evaluations, maximum 100 evaluations per tick and a 45-second loop deadline.
  The deadline is checked between RPCs, not during a blocked RPC.
- Recovery: global transaction advisory capacity fence, up to 100 due receipts,
  60-second check interval. Requirement row already uses SKIP LOCKED; mapping,
  session and receipt locks previously waited, and checked_at was outside the
  exception subtransaction.
- Catalog HTTP backfill: default 100, maximum 200 items; SQL accepts 1–500. One
  transaction holds previous item locks until completion. Source-row SKIP LOCKED
  does not protect the downstream document or embedding-job upserts.
- Catalog embedding activity: refresh 100, claim at most eight, two provider
  lanes. Existing 30-second backfill abort and all provider/request limits remain
  unchanged. No arbitrary batch reductions or process-local concurrency gates.

## Exact repair

1. `requirement-scheduler.ts` no longer labels every claim error as a missing
   migration. Controlled categories distinguish statement timeout, contention,
   other request failures, and function/schema-cache lookup errors. No raw database
   bodies are exposed and no write is retried.
2. `20261114210000_requirement_economic_recovery_contention.sql` puts candidate
   locks/writes, including checked_at, inside a rollback subtransaction; mapping,
   session and receipt locks use NOWAIT. Nested waits have function-local 50ms
   lock_timeout. Busy candidates retain their due receipt. Recovery's advisory
   acquisition is opportunistic; ordinary claim still owns its existing capacity
   fence. Full provenance, consent, quiescence, accounting and command guards stay
   unchanged. See `REQUIREMENT_ECONOMIC_RECOVERY_CONTENTION.md`.
3. `20261114210100_catalog_backfill_contention.sql` changes only the backfill
   entry point, not synchronous source triggers or refresh semantics. Each item's
   locks/writes roll back on lock contention/deadlock. The item is durably queued
   with revive_exhausted before returning its cursor. Queue failure fails the whole
   RPC rather than silently losing work. It uses function-local 50ms lock_timeout,
   restores caller settings, retains SQL bounds and service-only authorization.

These are explicit reviewed forward definitions, not blind SQL-text rewrites.
No historical migration or oversized test was edited. All added/touched files
are below 500 lines.

## Verification

Run with `PATH=/opt/homebrew/bin:/usr/local/bin:$PATH`:

- `npm run test:harness:agent`: includes new controlled claim-error tests, complete
  original SQL regression replay with forward recovery installed, unchanged-guard
  assertion, and disposable multi-session PostgreSQL recovery contention tests.
- `npm run test:catalog-search`: includes new Jest wrapper for disposable
  PostgreSQL backfill contention and existing catalog unit/SQL/scale/visibility/
  recall regressions.

Results: full agent-harness **57 suites / 592 tests passed**; full catalog
**25 Jest suites / 304 tests plus 28 Node SQL/regression tests passed**. After the
final catalog ownership/unchanged-refresh assertions, the focused catalog rerun
passed **3 suites / 11 tests**. Focused requirement rerun passed **4 suites / 16
tests**. `git diff --check` passed. Offline telemetry emits expected unavailable
warnings; npm reports the existing unknown enable-pre-post-scripts setting.

Native contention tests use fresh socket-only clusters and no database environment
credentials. They test busy source/document/job and receipt/mapping/session/billing
rows, healthy-neighbor progress, rollback lock release with an open outer
transaction, durable later recovery, ACLs and local timeout restoration. Catalog
also tests failed deferral enqueue atomicity. Catalog PostgreSQL substitutes vector
math/storage and omits HNSW; actual production vector-index latency is not proven.

## Deployment limits

Nothing was built, committed, deployed or applied remotely. Before any approved
rollout, inspect installed definitions, owners, ACLs, triggers and migration history
and reconcile drift; do not reapply old files merely to fill absent history. Review
these forward definitions against installed functions. Stage with actual pgvector
indexes and production-like lots, then observe statement duration, lock waits,
checked_at progress, deferred backlog and normal admission. Deferred work can remain
busy; refresh drain and other scheduler/accounting operations can still time out.
Long-running scans/I/O and contention outside these entry points need separate
measurement and repair. No global timeout increase, unsafe write retry, auth
bypass, provider mock backend or unrelated market-fit inventory change was made.
