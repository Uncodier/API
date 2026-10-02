# Migration correction and centralized application review

## What changed

All new pending application SQL passes the same independent review before the
atomic Apps migration RPC: normal sandbox execution, restricted repair tools and
the platform migration endpoint. Review is bound to the exact SQL checksum,
verified tenant capabilities and canonical requirement instructions from Makinari.
Applied ledger entries retain their immutable path/checksum semantics.

Invalid static/dynamic SQL becomes `correction_required` without spending five
LLM repair turns on an operation the restricted tool cannot perform. The workflow
assigns concrete correction instructions to the existing implementation step,
or appends a bounded repair if its source step is completed. It retains the same
backlog item and enables sandbox tools. Corrections/reviews share a persisted
five-attempt historical budget. Exhaustion now enters the bounded independent
[diagnostic handoff](MIGRATION_DIAGNOSTIC_HANDOFF.md), not an immediate assertion
of irreparability or a generic permission request. Genuine security holds remain.

See [migration coordination recovery](MIGRATION_COORDINATION_RECOVERY.md) for the
subsequent missing-plan recovery and lifecycle-bound assignment reuse. Repeating
the same assignment in a new cron cycle no longer spends another attempt.

## Durable states and safety

`requirement_migration_lifecycle` is a Makinari service-role-only table:

- `correction_required`: assigned implementation work may continue.
- `reviewing`: review/write intent is recorded before the asynchronous operation.
- `validation_pending`: approval is recorded before SQL application; a matching
  ledger receipt and a fresh product gate are still mandatory.
- `validated`: the host verified both receipts and fresh product evidence.
- `platform_review`: execution requires technical reconciliation.

Transitions check requirement execution generation, row version and bounded
attempts. A database trigger prevents ordinary status tools, user-resume RPCs or
scheduled cron from reopening `platform_review`, and prevents delivery while any
migration remains unvalidated. Cron checks before adding new work. A new workflow
checks pending validation before running ordinary product steps. For a partial
batch with dependent corrections, it allows only the assigned correction before
validating the batch; delivery remains forbidden. Exceptions cannot
erase the durable obligation; missing persistence fails closed.

The SQL scanner now distinguishes ordinary strings from PostgreSQL escape strings,
handles quoted identifiers without treating their content as executable SQL, and
refuses malformed input. Policy comparison never silently drops unparsed Unicode
identities from its security checks.

## Product decisions

The reviewer can only return a customer question when the host supplies an exact,
typed pending decision (identity, kind, question, options and specification excerpt).
An arbitrary quote plus a model-written "authorize SQL repair?" is rejected.
Current application callers do not invent pending decisions; ambiguous business
semantics without such a record remain technical review. No generic customer
approval releases a technical hold.

## Rollout

1. Apply `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20260930010000_requirement_migration_lifecycle.sql`
   to **Makinari**, not Apps. This session does not apply it remotely.
2. Deploy the API. Missing table/RPC is an error, not a fallback to unsafe behavior.
3. Canary a scoped pending migration: reject, assign correction, review, apply and
   verify. Inspect the lifecycle rows and the existing workflow/tool logs.

Existing blocked requirements are not reopened, and old migration receipts are
not retroactively reviewed by deployment. Technical operators must reconcile any
pre-existing ambiguous work separately. Platform-review release is an explicit
service-role lifecycle transition; no new customer-facing release UI is included.

Two database projects cannot share one transaction. The Makinari validation intent
is persisted before calling the Apps atomic RPC; interruptions remain pending and
are reconciled against exact Apps receipts instead of being treated as success.
If a later migration fails during review or transport, the outcome preserves the
receipts of earlier successfully applied files.

## Validation

Use `npm run test:harness` from `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`.
Tests include live in-memory PostgreSQL lexical/permission/trigger checks, CAS,
stale generations, writer-route parity, correction assignment, review binding,
interrupted review/application, fresh gate enforcement and scheduled-resume denial.
No live customer SQL, deployment or production workflow is run by these tests.

Local validation checkpoint: **128 suites / 1,626 tests passed**. The two lifecycle
suites additionally passed together (102 tests, including the existing resume RPC
against in-memory PostgreSQL). Repository-wide TypeScript still reports 158 errors
outside this change; none were reported in the touched migration/harness files.