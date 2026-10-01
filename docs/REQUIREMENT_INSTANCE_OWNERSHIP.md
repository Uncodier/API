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

## Rollout and boundaries

Apply `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261001010000_requirement_assistant_handoff.sql`
**before deploying the API**. The handoff RPC is mandatory; if absent, cron
defers instead of guessing. The migration preserves existing capacity and
generation checks through internal implementation functions. Future scheduler
migrations must retain these admission wrappers. Reapplication is idempotent.

This change does not merge, archive, resume or reassign historical duplicates.
Their canonical metadata may already point to the cron-created instance, so they
need explicit reconciliation. API-created requirements without an assistant
retain the unassigned cron path. Unscoped legacy chats cannot be inferred safely
from log text; they are not retrospectively assigned. Provider/sandbox repair
does not itself require a new `remote_instances` row. Already-dispatched external
effects cannot be undone by an admission guard.

The migration and API changes were validated locally, not deployed. Regression
coverage is included in `npm run test:harness`, including in-memory PostgreSQL
tests of both admission orders, active/paused/failed states, same-instance reuse,
terminal cleanup, and service-role permissions.