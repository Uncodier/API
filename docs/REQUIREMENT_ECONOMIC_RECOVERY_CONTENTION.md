# Requirement economic recovery contention

## Focused forward repair

`20261114210000_requirement_economic_recovery_contention.sql` replaces only
`recheck_requirement_economic_pauses(uuid[])` with its reviewed
`20261026030000` definition plus contention handling. It does not rewrite function
text from the database catalog or change claim/command admission RPCs.

Previously the requirement, mapping, session and private receipt locks, and the
`checked_at` update, preceded the per-candidate exception block. A concurrent
receipt update could therefore consume the scheduler statement timeout before
ordinary requirements were considered.

The forward definition:

- Keeps the 100-candidate oldest-checked-first scan and 60-second reevaluation
  interval. There is no evidence justifying a smaller batch.
- Uses the same global capacity advisory fence, but recovery returns immediately
  if another transaction owns it. The ordinary scheduler's capacity fence remains
  unchanged; this is not a global scheduler contention repair.
- Keeps requirement `SKIP LOCKED`; mapping/session/receipt acquisition uses
  `NOWAIT`. Missing sessions retain their original handling.
- Applies a function-local `lock_timeout = '50ms'` to nested owner, command,
  action, billing and trigger locks. It is restored on function exit; no global
  statement timeout is increased. This is a lock-wait budget, not a bound on SQL
  aggregation or total RPC runtime.
- Moves all candidate locks and writes, including `checked_at`, into the existing
  exception subtransaction. Lock unavailability/deadlock rolls back the candidate
  and releases its acquired locks without another diagnostic write. The receipt
  stays due, so a later invocation can revisit it without resetting provenance.
- Retains SQLSTATE-only diagnostics for other errors; the diagnostic write has its
  own lock/deadlock catch so it cannot propagate contention from the error path.
  Statement cancellation still propagates; no unsafe write is retried.

The full guard-through-recovery body is unchanged: tenant/runner authorization,
private provenance and latest status identity, generation/session versions,
leases, holds, cleanup, pending/uncertain effects, ordered trusted command chain,
accounting, funding minimum and atomic command application remain intact.
`SECURITY DEFINER`, `search_path = pg_catalog`, private table RLS and the
non-executable helper ACL are retained. No receipts or historical rows are
backfilled by this migration.

## Offline evidence

Run from the API workspace:

```sh
PATH=/opt/homebrew/bin:/usr/local/bin:$PATH npm run test:harness:agent -- \
  --runTestsByPath \
  src/lib/harness/__tests__/requirement-economic-recovery-sql.test.ts \
  src/lib/harness/__tests__/requirement-economic-recovery-postgres.test.ts
```

The small SQL regression test extracts the complete existing requirement-cron
PGlite script and injects the forward migration immediately after recovery `300`
loads. The oversized original test is not edited. A second assertion compares the
entire guard/recovery body byte-for-byte with that historical definition.

The native test uses PostgreSQL 17 at
`/opt/homebrew/opt/postgresql@17/bin`, a disposable workspace-local cluster and
Unix socket (no TCP, remote credentials or database). Separate connections hold
receipt, mapping, session and billing row locks. Each service-role scheduler call
claims unrelated ordinary work in under 1.5 seconds, while the paused requirement,
mapping, transcript/counters and receipt including `checked_at` remain identical.
An outer recovery transaction stays open while a third connection verifies the
candidate requirement lock was released by subtransaction rollback. After locks
are released, the scheduler recovers the same session/generation exactly once.
The test checks helper/table ACLs, security-definer settings and timeout restoration.
It explicitly skips when native binaries are absent; PGlite alone does not prove
multi-connection contention.

No migration was applied remotely. Because the remotely installed RPC history is
not available locally, deployment requires an operator to verify the installed
recovery definition matches the reviewed `300` guard contract (or reconcile any
newer guards first). This forward definition must not replace unknown newer
remote behavior blindly. Ordinary claim/command-drainer contention and expensive
accounting remain outside this repair's scope.
