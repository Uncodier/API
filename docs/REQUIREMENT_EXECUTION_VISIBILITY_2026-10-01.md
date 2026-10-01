# Requirement execution visibility

## Cause

The migration lifecycle RPC can stop a requirement independently of its runner.
Previously only `requirements.status` became `blocked`; the instance and plan
could remain `running`/`in_progress`. The next cron tick can revoke that lease,
so a later worker or model-generated wrap-up is not a reliable status publisher.

The interactive assistant loaded requirement status but not migration holds.
`instance_plan.execute_step` reported a successful plan update, not an actual
executor start. The web hook read append-only status history and backlog without
the requirement's current status; its blocked status card was not rendered.

## Changes

- Forward migration `20261001190500_migration_hold_visibility.sql` publishes a
  bounded hold projection, linked plan/instance stop, and status history in the
  same transaction as the lifecycle receipt. It preserves manual pauses,
  completed work, unrelated instance work and other files' holds. Release never
  automatically resumes work or clears historical budgets.
- The assistant reads operational migration hold fields (not SQL or review
  payloads). Step status reporting rejects held/non-runnable requirements and
  explicitly reports `execution_started: false`. Direct plan updates also check
  the hold before reactivating a requirement-bound plan.
- The web hook overlays authoritative requirement status and its hold projection,
  subscribes to requirement updates, avoids stale instance data, and renders a
  blocked status card. Legacy blocked rows still display without the migration.
- The diagnostic tool now advertises the separate hypothesis, implementation and
  verification fields that its validator requires. A rejected candidate no longer
  returns `accepted: true`. The existing one-diagnostic budget is not reset.

## Live reconciliation and limitations

A scoped legacy budget-only hold was reconciled after confirming unchanged
specification, matching failed bytes in its existing stopped sandbox, absence of
an applied migration receipt, no active execution, and no previous diagnostic.
The deployed cron claimed the requirement and ran its independent diagnostic.
That proposal omitted the required hypothesis/instruction/verification fields;
the host rejected it without applying SQL. The current plan is blocked, the
instance is pending, and the execution lease is released. No applied migration,
customer data, budget, or diagnostic receipt was rewritten.

The proposal also suggested creator-only access despite organization collaboration
and legacy data without ownership. It is not an approved application repair.
Further implementation needs verified ownership/membership evidence; do not
replay the diagnostic or mark delivery complete merely because tests pass.

Production data reconciliation does **not** deploy these source changes. Apply
the forward migration to Makinari (not Apps), then deploy the API and web changes
through the normal approved release process. Drain incompatible old workers.
Do not backfill/release other holds automatically. Existing local web edits from
other work are outside this change and must not be included indiscriminately.

## Validation

Use `npm run test:harness` in the API repository. SQL tests execute in isolated
PGlite, including rollback, permissions, manual pauses, unrelated plans,
multi-file holds and compatibility with diagnostic settlement. Web regressions
cover authoritative state, realtime invalidation and blocked-card rendering.
No test authorizes application SQL or production deployment.

Validation checkpoint: API harness **153 suites / 2,030 tests passed**; focused
web regressions **4 suites / 10 tests passed**; web TypeScript and targeted lint
passed. API-wide TypeScript still reports 203 existing diagnostics, with no new
diagnostic lines compared with the baseline captured during this investigation.
No production build or source deployment was performed.