# Existing-requirement execution verification

## Why the task canaries are insufficient

The sibling frontend's `scripts/harness-e2e/cases.cjs` seeds five `task`
requirements and activates them directly. They test filesystem work, repair,
continuation and plans, not an interactive modification of an existing `develop`
app. Passing offline tests of that runner is not passing deployed E2E.

Read-only database inspection on November 3, 2026 found real requirement types
including `develop`, `design`, `testing`, `content`, `analytics`, `research`,
`follow_up`, `approval` and `payment`. Do not silently convert these to `task`.
Choose a type-specific independent acceptance oracle. Payment/approval scenarios
must never perform real transactions or approve real customer work.

The inspected existing-app request had a completed trusted user action and an
applied command, but no harness run mapping/session or recent status evidence.
An `action_unfinished` diagnostic during submission was transient, not the final
blocker. Applied instructions do not prove execution. No customer IDs, instructions,
source, credentials or transcripts are included in these fixtures.

The installed private claim function was also inspected read-only: it required
both creation and update dates on or after September 1. The existing app was
created in April and updated in November, so the creation predicate excluded it
even after command application. A concurrent working-tree date-scope repair is
documented separately in
`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/REQUIREMENT_DATE_SCOPE_2026-11-03.md`.
This E2E work does not apply that migration or deploy it. Include historical app
creation dates in test fixtures; recent synthetic rows cannot expose this defect.

## Read-only handoff liveness probe

`scripts/harness-requirement-handoff.mjs` observes the actual persisted command,
trusted action and canonical session. It does not submit a request, invoke cron,
apply commands, claim leases, provision a VM or repair production state.

Use a dedicated authorized test requirement and provide these variables through
the shell's secure environment (the script deliberately does not load `.env`):

- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `HARNESS_E2E_PROJECT_REF` (must match the database URL)
- `HARNESS_E2E_SITE_ID`, `HARNESS_E2E_USER_ID` (requirement owner),
  `HARNESS_E2E_REQUIREMENT_ID`
- Optional `HARNESS_E2E_DEADLINE_SECONDS`, default 300, maximum 1800.

The service-role credential is private and server-only. Explicitly authorize the
exact tenant and requirement before using it. All reads are tenant scoped; the
requirement and session must also match their owner.

1. Capture a baseline **before** sending the change through the normal robots UI:

   ```sh
   node /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/harness-requirement-handoff.mjs baseline /tmp/harness-handoff-baseline.json --ack-private-read-only
   ```

2. Send one change request to the existing test app, let its interactive action
   finish, and allow the normal requirement cron to execute. Do not seed an
   alternative task or manually clear holds to make it pass.
3. Check execution against the immutable baseline:

   ```sh
   node /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/harness-requirement-handoff.mjs check /tmp/harness-handoff-baseline.json --ack-private-read-only
   ```

Exit 0 means **handoff liveness only**, not delivery: a newer applied command,
completed submitting action, correctly bound session and new successful workspace
receipt were observed before the deadline. A successful `exec` could be inspection,
so the probe deliberately always reports `healthGreen: false` and
`deliveryVerified: false`. Exit 1 means pending or timed out; exit 2 means unavailable
observation/configuration. Missing evidence is never skipped or labeled passing.
The baseline is created exclusively with mode 0600 and refuses overwrite. Store it
outside Git, do not modify it after submission, and remove it after verification.

## Delivery E2E acceptance

The new sibling frontend existing-app cases and evaluator supplement, rather than
weaken, the old canaries. A full run must capture a source/behavior baseline,
submit through the normal assistant path, observe command application and cron
execution, then collect independent after-source and functional evidence. Require:

- Same existing requirement and its real type; new trusted authorization revision.
- Fresh, matched execution receipts, not historic completed transcripts.
- Actual source changes in allowed app paths; README/request-only edits fail.
- Acceptance checks from the test host against the changed source/artifact, not
  assistant text or fabricated tool results.
- For visual polish: visible layout change at mobile and desktop sizes while
  preserving branding, copy, prices, navigation and reservation behavior.
- For bug repair: independently reproduced failure before and success after,
  with the same unchanged test and preserved unrelated behavior.
- Timeout without execution is a failure, even if HTTP/SSE accepted the request.

Live execution requires an explicitly approved disposable existing-app fixture,
funded test tenant, authenticated assistant path and independent source/browser
access. These prerequisites were not provisioned or bypassed in this change.
No live delivery pass is claimed and no production mutations were performed.

## Offline validation

```sh
node --test /Users/prado/Desktop/Proyectos/Uncodie/Code/API/__tests__/harness-e2e/handoff.test.mjs
node /Users/prado/Desktop/Proyectos/Uncodie/Code/API/node_modules/jest/bin/jest.js --config /Users/prado/Desktop/Proyectos/Uncodie/Code/API/jest.agent-harness.config.js --runInBand --runTestsByPath /Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/harness/__tests__/requirement-command-sql.test.ts
```

The SQL regression executes forward migrations in ephemeral PGlite and verifies
the existing `develop` app's interactive command is not claimed until the action
finishes, then admits the fresh scope on its original runner. It is connected
database integration coverage, not a live model/sandbox/browser E2E.