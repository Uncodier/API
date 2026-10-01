# Evidence-directed harness diagnosis

## Scope

This change improves the existing requirement-plan executor and Judge repair
controller. It does not introduce persistent agent sessions, increase turn or
repair budgets, rewrite instance plans, resume blocked work, or change delivery
authorization. The shared history formatter also serves workflow-run retries;
the standalone assistant plan executor is not migrated to a new engine.

## Behavior

- Step history is a bounded 12,000-character view of complete reference blocks,
  not an arbitrary tail of concatenated messages. Each available source UUID
  includes the canonical `instance_history` JSON length and pagination offsets.
  A separate tenant/instance/plan/step-scoped query retrieves older normalized
  failures and supported legacy error envelopes beyond the 100 recent logs.
  The latest recorded failure is not presented as proof it remains unresolved.
- Direct read-only `instance_history` is available during restricted repair;
  the generic tool router and unrelated mutation tools remain restricted.
  Retrieval remains within the existing turn/budget limits.
- The host records bounded action/state/result observations in existing
  `instance_logs` infrastructure events (`cron_infra_action_observation`).
  Argument digests ignore reasoning noise; result digests ignore a small set of
  top-level timing fields. Unknown, partial, oversized and transport-error
  observations break comparability. Duplicate event identities are not counted
  twice. Log text cannot activate an execution guard.
- The observed state includes workspace bytes (including tests/config), sandbox
  identity and execution generation. Three comparable test failures produce
  diagnostic feedback, **not a hard block**: external services and time-dependent
  inputs may have changed. Local repeated reads can be blocked only after the
  exact requested content and metadata are checked independently of Git.
  Missing/unreadable state never proves a no-op. Remote, browser and background
  observations are not inferred from a repository fingerprint.
- Judge repair observations relate receipt-backed attempted executions to fresh
  canonical verification evidence, diagnostic identity, contract revision and
  workspace fingerprint. Repeated comparable failures add a new-hypothesis /
  targeted-check instruction to the next action's `verification` field, which
  the existing executor consumes. A successful tool call is not proof of repair.
  Duplicate evidence preserves action identities, status and budget. Existing
  diagnostic-change budget policy is unchanged.

## Boundaries and limitations

This is bounded deterministic detection and feedback, not automatic root-cause
discovery. Historical evidence IDs are provenance references, not history-log
UUIDs; the latest canonical backlog evidence/mirror does not constitute a full
historical evidence store. Missing or reused verification context stays unknown.
Arbitrarily nested or JSON-string-only legacy failure payloads may require
explicit history retrieval. Unsupported actions still use existing budgets and
gates; no new failure is inferred from their absence in observation history.

Observation logging is best effort: its failure must not replay a tool that has
already executed. It is not an exactly-once operation ledger. Fingerprint reads
add local inspection work; they do not call another model. No secrets or full
tool arguments are copied into observation metadata; excerpts are redacted.

## Rollout

Deploy the API through the normal process. No database migration or data backfill
is required. Old logs without comparable state do not acquire a retrospective
hard block. Existing plan definitions and statuses are not changed by deployment.

## Validation

Run `npm run test:harness` from
`/Users/prado/Desktop/Proyectos/Uncodie/Code/API` using Node 22. The offline tests
exercise the real formatter, observation/guard functions, scoped history reader,
executor wiring and postgate repair persistence with mocked I/O. Coverage includes
legitimate retests, service recovery allowance, changed/ignored file content,
oversized-result barriers, duplicate observations, contract changes, restricted
retrieval, source offset parity and ownership rejection. These tests are not a
claim of production deployment or measured autonomous task success gains.