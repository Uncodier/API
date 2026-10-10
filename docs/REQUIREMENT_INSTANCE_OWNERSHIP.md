# Requirement instance ownership

## Duplicate runner incident

Read-only inspection of requirement `d4049bf8-21bb-48e7-8aa7-869feab35133`
confirmed that its interactive instance created the requirement at
2026-10-01 00:01:57 UTC. At 00:02:52 UTC the requirements-apps cron created a
separate `req-runner-*` while the original still made tool calls.

The create tool did not receive the originating instance identity. The scheduler
looked for runner metadata, a canonical name, and status history; an interactive
plan or unfinished chat was not sufficient. The foreign-agent check happened
after creation and ignored activity on the selected instance. Reactivation also
resumed both named runner and maintenance instances.

## New behavior

- The assistant's server-side tool closure passes its instance identity into
  requirement creation. The initial insert saves `runner_instance_id` and
  `assistant_origin_instance_id` together, after validating site/instance scope.
  Model-authored metadata cannot set these keys.
- Cron checks handoff **before preparation or creation**. Legacy requirement-bound
  plans are consulted before the canonical runner name. A missing historical
  owner does not authorize another instance.
- A trusted user action must be `completed` or `failed` before cron can continue
  on that instance. Long silence, missing checkpoints, paused/stopped/cancelled
  actions, and archived instances fail closed. A completed planning conversation
  can hand the plan to cron on the **same logical instance**; completion does not
  create a replacement. A confirmed failure also tries that same identity first.
- Database activation and per-dispatch ownership assertions repeat the handoff
  check. For newly origin-bound requirements, user-action admission and cron
  activation serialize on the requirement row. A message received during an
  active cron cycle gets HTTP 409 `REQUIREMENT_EXECUTION_BUSY`, without marking
  the healthy instance as failed. Retry in the same instance after the cycle.
- `activate_coding_agents` no longer wakes named instances. It requires the
  assigned owner and a running, trusted, requirement-scoped user action, and uses
  the existing recovery RPC. Migration review holds remain intact.
- Owned terminal cleanup retains its prior generation/run/lease checks and can
  still release a paused instance's sandbox.

## Archived owner replacement

An explicitly archived runner is historical, not an active owner that must be
reused forever. The requirements-apps cron distinguishes archival from an
ordinary pause, stop, timeout, missing checkpoint or unavailable lookup:

- Non-archived owners keep the existing same-instance admission rules. Pausing
  an instance or its plan does not authorize a replacement.
- An archived owner can be replaced only under the current, unexpired, inactive
  cron claim. `replace_archived_requirement_runner` verifies owner, site and
  execution generation under row locks, then atomically creates a pending runner,
  changes the owner, increments the generation and transfers that requirement's
  nonterminal plans. Retrying the same claim does not create another runner.
- Plan IDs, steps, completed work, acceptance contracts, retry state and manual
  plan pauses are preserved. Terminal plans and logs remain historical. Backlog,
  Git binding, budgets and migration/security holds are not reset or released.
- Legacy nonterminal plans without a plan-level `requirement_id` also transfer
  intact when their declared plan/step backlog links all belong to this requirement
  and the old instance has no competing requirement association. Unlinked,
  malformed, mixed or shared-owner legacy plans defer the entire reassignment
  without partial writes. Independent workflow-run/template plans stay untouched.
- The original assistant identity remains historical. A database-owned
  reassignment receipt authorizes cron handoff to the replacement; arbitrary
  metadata or model text does not.
- Older workflows are fenced by their generation. An unexpired active execution
  cannot be replaced just because its runner became archived.
- An unfinished trusted assistant action on the archived owner also defers
  replacement until it has a confirmed terminal or inactive status. New trusted
  actions and workflow preparation on archived instances are rejected; archival
  does not silently cancel a potentially in-flight external effect.
  `completed`/`failed` outcomes take precedence over an old recovery `inFlight`
  checkpoint. Paused/stopped/cancelled actions with that marker still set remain
  guarded rather than assuming that an external operation stopped.
- Canonical lookup prefers a non-archived runner, but when only an archived one
  exists it passes through the same atomic replacement path, including legacy
  requirements without owner metadata. Archived rows never execute directly.
  Recent status history from explicitly archived instances no longer counts as competing live
  work; missing observations still defer conservatively.
- Assistant admission serializes with cron for every current owner, not only
  those with `assistant_origin_instance_id`. An origin-less replacement cannot
  accept a concurrent chat while its cron execution is active.
- Quiescence of an archived assistant is checked before preparation can update
  backlog/resume state, and repeated inside the replacement transaction.

Apply `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261010010000_replace_archived_requirement_runner.sql`
**before deploying this API**.
If the RPC is missing or its receipt cannot be verified, cron defers without
creating a fallback or rewriting ownership. Reassignment is not itself proof
that sandbox provisioning, migration verification or product delivery succeeded.
The replacement provisions its own sandbox using the retained requirement Git
binding. It does not copy credentials, environment variables or an archived
instance's snapshot; unpushed files in that old sandbox are not recovered by this
operation. Saved plans and pushed repository work are preserved, not proof that
all old local changes were saved.
The existing instance-with-requirements deletion endpoint remains conservative
about mixed historical origin/runner ownership. Reassignment does not grant
permission to delete the archived origin together with the active requirement;
those historical cleanup cases require the existing operator/root workflow.

## Rollout and boundaries

Apply `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261001010000_requirement_assistant_handoff.sql`
**before deploying the API**. The handoff RPC is mandatory; if absent, cron
defers instead of guessing. The migration preserves existing capacity and
generation checks through internal implementation functions. Future scheduler
migrations must retain these admission wrappers. Reapplication is idempotent.

The original handoff migration does not merge, archive, resume or reassign
historical duplicates. Archived owners now have the bounded cron replacement
path above; non-archived historical duplicates still need explicit reconciliation.
API-created requirements without an assistant
retain the unassigned cron path. Unscoped legacy chats cannot be inferred safely
from log text; they are not retrospectively assigned. Provider/sandbox repair
does not itself require a new `remote_instances` row. Already-dispatched external
effects cannot be undone by an admission guard.

The migration and API changes were validated locally, not deployed. Regression
coverage is included in `npm run test:harness`, including in-memory PostgreSQL
tests of both admission orders, active/paused/failed states, same-instance reuse,
terminal cleanup, and service-role permissions.