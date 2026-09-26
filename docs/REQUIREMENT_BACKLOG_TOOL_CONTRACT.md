# Requirement backlog tool reads and retry safety

The model-facing `requirement_backlog` tool returns `success: true` only after
its action completes. HTTP errors return `success: false` with `error`. An
unasserted result from another tool remains `operation_outcome: "unknown"` and
is logged with `success: null`, not `false`. Nested operational failures still
take precedence over an outer success flag.

## Reading the backlog

- `action="list"` is a read-only summary. It defaults to `list_status="open"`
  (excludes `done` and `rejected`) and returns at most 20 items, active first.
- Set `list_status="all"` or an exact status to inspect other queues. Set
  `limit` to an integer from 1 to 50 and use `pagination.next_offset` while
  `pagination.has_more` is true.
- `summary.total_items` and `summary.counts_by_status` describe the entire
  canonical backlog, not just the filtered page. An empty page does not mean
  the requirement has no work or is complete.
- `summary.active_item_ids` includes active review states. Reuse existing work
  instead of starting another item. Runnable counts respect blockers,
  dependencies, quarantine, product attempt limits and pending cancellation.
- `action="get"` requires `item_id` and returns that complete item, including
  its acceptance contract, constraints, evidence and history. Fetch this before
  planning or updating an item. A missing item is an error, never success.

Summary items retain product attempts, tool failure counters, current blocker
summaries, quarantine state, and the last evidence verdict. Large history,
acceptance contracts and test output are available through `get`; they are not
removed from storage. Historical evidence is not a new verification result.

Backlog tool calls do not trigger user-action recovery in the background.
Trusted user-action handlers still own that separate lifecycle operation.

## Upsert identity and lifecycle

Use the existing `item_id` to update work. Omitted or `undefined` fields no
longer erase persisted counters, constraints, quarantine, cancellation requests,
scope or dependencies. Internal callers retain explicit-value update behavior;
model-facing actions still cannot rewrite terminal items.

Creation checks the latest snapshot inside every optimistic-concurrency retry.
It rejects an equivalent named task with the same nonempty acceptance set,
including `Remediation N:` / `Bugfix:` title prefixes and new UUIDs. The error
identifies the existing item and status; it neither reopens nor rewrites it.
Explicitly different declared scope or claims remain distinct. This is a
conservative identity check, not fuzzy semantic deduplication.

## Scope and validation

These changes do not merge existing duplicates, reopen production items, change
global user-action recovery policy, or weaken verification gates. No database
migration is required. Deploy the API code to use the new contract; existing
stored logs retain their historical values.

Run the offline regression suite with `npm run test:harness`. It includes
backlog read/protocol/HTTP tests, summary pagination and size tests, atomic
upsert and lifecycle tests, prompt compatibility, and both tool loggers.