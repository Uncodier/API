# Recovery policy, not a universal reconciler

Uncertainty is a missing confirmation, not proof of failure or permission to replay.
It must not become a product gate for the whole requirement.

The canonical requirement boundary now distinguishes:

- A closed, durably saved uncertain write: other work and normal idle-deadline
  continuation remain available. Its uncertainty stays in history; only policies
  requiring external verification prohibit another identical attempt.
- An exact host timeout interrupting a durably saved canonical tool batch:
  `canonical_slice_interrupted` yields to the next cron cycle. Initialization
  records unknown outcomes for dispatched calls and not-executed receipts for
  calls without a dispatch checkpoint. It never replays the original batch.
- In-flight model/accounting, ownership, storage and other generic boundary
  failures: existing fail-closed handling remains. Merely having a canonical
  checkpoint or a simultaneously expired timer does not make these retryable.

The first classified boundary failure is retained in host memory. If a tool
adapter catches an ownership/lease exception and returns ordinary error data,
the outer boundary still throws that original sanitized failure. A later timeout
cannot downgrade it to `canonical_slice_interrupted`; no result/checkpoint save
or additional dispatch is authorized on that poisoned adapter. Normal idle
timeouts and verified canonical interruptions retain their existing continuation.

Workspace and cloud handlers preserve pending calls/fences when yielding. A
concurrent user pause is not overwritten. The existing cron and session are reused;
no new scheduler, budget reset, automatic product acceptance or deployment is added.

`harness_inspect`, `harness_events`, `harness_reference` and `harness_source` are
host-classified diagnostic reads, including calls through the existing router.
A returned observation object without a success flag is a successful observation,
not a claim that the inspected system is healthy. Explicit failures and unavailable
fields remain visible; read failures do not create uncertain-write fingerprints.
`harness_decide` and unknown tools are not covered by this exception. Classification
does not bypass permissions, routing, scope checks or the actual tool callback.

## Host-owned operation policy

`reconcile_operation` is removed from the canonical catalog and router's always-on
list. Historical calls receive a non-executed `TOOL_RETIRED` receipt. The runner
does not call legacy `reconcile` adapters or use `reconciledOperations` to grant
retries/materialize success. Old snapshot fields remain readable and unchanged.

| Policy | Behavior after uncertainty |
| --- | --- |
| read | The agent can request another read; no uncertain-write fingerprint is created. |
| inspect | The agent inspects current state and requests fresh corrections. No proof RPC or reconciliation command is required. |
| retry_safe | A fresh request is allowed only when the host adapter declares idempotency across call IDs. The runtime does not invent stable provider keys. |
| verify_external | Unknown external/unclassified effects cannot be repeated without a safe adapter contract. A blocked retry returns `OPERATION_RETRY_UNSAFE`; independent work continues. |

`apply_patch` uses `inspect`: file creation and exact-text replacement constraints
still apply, and partial batches must be inspected before correcting remaining
changes. Arbitrary shell commands remain `verify_external` because they may invoke
external APIs; process status/output and other read tools remain available. Policy
does not prove that the model inspected correctly or prevent semantic duplicates.
Provider policies are narrow, not a blanket grant for external writes:

- `sandbox_db_provision`: `retry_safe` for the existing atomic per-requirement
  tenant operation. Each new attempt still validates ownership/generation and
  the tenant receipt before issuing scoped credentials or configuring environment.
- `sandbox_storage_ensure`: `retry_safe` for deterministic tenant-private storage
  ensure/read-back. Binding identity, privacy and policy checks still apply.
- `tracking_install`: `inspect`; each new attempt reads and transforms current
  source, without a second script insertion or an implicit deployment.
- `sandbox_db_migrate`: explicit `verify_external`. Its old reconciler's tenant
  lookup was not proof of a migration batch outcome. Per-file atomic checksum
  receipts do not pin the parameterless batch's mutable files/SQL. An uncertain
  batch remains protected from blind retry; this change does not implement a
  pinned, safely retryable migration-batch contract.

The obsolete capability and tracking reconcilers are removed. Ordinary model
claims still cannot override these policies or remove historical uncertainty.

Cloud `replace`/`patch` with file identity and expected version use `inspect`;
their normal schema, permission and version-conflict checks remain authoritative.
Cloud `create` remains `verify_external`: a fresh call ID produces a different
operation identity and is not an idempotent retry of the original creation.

Classification is host code (optionally action-specific), never a model argument.
Direct and routed calls use the same policy and fingerprint. Permission, ownership,
scope, validation and persistence checks still run. No completed call is replayed
automatically, no uncertainty history is deleted, and ordinary instance logs do not
require reconciliation. The agent uses paginated history and state tools normally.

## Existing paused sessions and rollout

These changes do not automatically unpause historical sessions or delete their
uncertainty. Generic historical `boundary_failed` reasons do not identify whether
storage, accounting or execution failed. Inspect each checkpoint and evidence
before a scoped resume using the existing owner-checked mechanism. No production
state or deployment was changed by this implementation.

## Offline validation

Boundary tests cover diagnostic observations/errors, persisted uncertainty across
idle deadlines, interrupted reads/writes/unstarted calls, next-cycle recovery,
blocked replay and continued inference. Cloud/workspace tests cover waiting versus
hard pauses while preserving checkpoints. These are not live provider E2E tests.