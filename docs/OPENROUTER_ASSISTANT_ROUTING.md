# Assistant customer routing checkpoint

Local implementation checkpoint, 2026-11-12. Customer execution activation remains
disabled by `rolloutEnabled()`. No provider calls, deployment, migrations, or
production build were performed for this tranche.

## Implemented boundaries

- HTTP admission resolves routing only after site access authorization. Disabled
  rollout does not query the new connection tables. Without a selected connection,
  the original `0.001` inference-credit preflight remains enforced.
- A validated customer reference bypasses only that inference-credit check. VM,
  workspace, resource, and requirement monetary-budget controls remain intact.
- Public request parsing has no payer/reference field. Host workflow options carry
  only payer, site, connection ID, policy version, and credential version.
- Recovery snapshots strictly validate the reference and reject extra fields such
  as credentials. Resume uses the claimed snapshot, not new workflow options or
  the site's latest selection. Legacy snapshots retain platform routing.
- Context preparation restores the pin before background/history helpers and pins
  the customer's tools model instead of the global model for initial budgeting.
  Every canonical turn restores the reference independently, including direct core
  calls and durable turn steps. Child tools inherit the runtime scope.
- Recovery preparation revalidates pinned customer credentials even when rollout
  is disabled. Revocation blocks continuation; it does not fall back to platform.
- Silent continuation/cron respawn passes the snapshot reference into the new
  workflow. Pending-work admission resolves a fresh host-owned reference.
- Requirement cron persists its reference in the immutable session request for
  both cloud and workspace execution. Subsequent cycles restore it before context
  and execution. The canonical requirement slice also restores the session pin.
- ALS is never entered in a `use workflow` function. The real Workflow compiler
  test confirms routing/storage modules are absent from the deterministic bundle.
- Standalone workflow and delegated plan creation now publish private immutable
  routing pins before customer plans become runnable. Run-plan, bounded channel
  execution, standalone plan steps, and legacy plan-act restore those pins, never
  public plan metadata. SQL 220 backfills legacy platform pins; a missing pin once
  routing storage is enabled is an error. Keep the storage-ready flag enabled on
  rollout rollback so previously admitted customer plans cannot become platform jobs.
- Instance compaction uses the semantic `summary` capability without a global-key
  precheck for customer execution. Summaries and retrieval retain the existing
  `openai/text-embedding-3-small` / 1536-dimensional space; incompatible customer
  embedding policies fail closed, leaving the cursor unchanged and using the
  bounded history view. Global missing-key and Azure deployment behavior remain.
- Canonical turns and summary batches establish stable operation namespaces for
  dispatch deduplication. Node execution authenticates and authorizes the stored
  node site before resolving routing; response-node IDs isolate parallel requests.

## Activation blockers and limits

Execution remains disabled pending rollout approval and real-provider acceptance:

- Direct internal workflow starters must provide an authorized reference;
  they do not discover customer selection implicitly on resume. Registered gear
  starter coverage belongs to the shared runtime tranche.
- The initial tools-model budget does not prove all later vision/structured/summary
  capability model budgets match their policy-selected context limits.
- Unsupported nested media/search/embedding adapters and cross-process delegations
  require separate coverage. Runtime guards must fail closed rather than funding
  them through platform credentials.
- Requirement session JSON persistence is covered offline, not by applying or
  probing production SQL. Database invariants and complete surface coverage must
  be verified before enabling the hard rollout gate.

## Offline validation

With Node 22 on PATH:

```sh
npm exec -- jest --config jest.assistant-runtime.config.js --runInBand
NODE_OPTIONS=--experimental-vm-modules npm exec -- jest --config jest.assistant-runtime-esm.config.js --runInBand
```

Latest local CJS checkpoint: 52 suites / 848 tests passed. ESM/compiler checkpoint:
15 suites / 249 tests passed. Context manager and node route regressions passed
48 tests; bounded channel execution/billing regressions passed 23 tests. The four
summary capability tests passed again after policy-selected preflight model wiring.
The latter includes the in-memory real Workflow compiler test, not a Next build.
Ten dedicated routing cases cover rollout/no-connection behavior, customer
admission without platform balance, serializable pins, snapshot precedence,
revocation, malformed/cross-tenant references, and cron legacy/customer restore.