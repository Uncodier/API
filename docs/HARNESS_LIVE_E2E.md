# Live existing-app E2E

This opt-in suite actually submits requests to the deployed assistant with an
authenticated test user's token. The assistant's real requirement update tool
queues a command; the ordinary production cron runs the canonical model/tool
loop. No local model replacement, fake tool receipt or forced cron dispatch is used.

## Three cases

All three retain the real DB type `develop` and operate on an already-seeded
synthetic vanilla HTML/ESM application in four files under `.harness-live/<run>/`:

1. **Landing polish:** computed Chromium desktop/mobile geometry, responsive grid,
   hero typography/padding/background and card padding/radius; preserve copy,
   brand, product prices and links.
2. **Quantity subtotal:** actual module arithmetic vectors and rendered UI quantity
   changes, zero quantities, empty cart and fractional amounts.
3. **Category filter:** exported pure function and actual select/card/count wiring,
   All restoration, unknown categories and quantity preservation.

The verifier lives outside the agent-writable fixture. Source modules run in a
bounded empty-environment subprocess using Node's permission model. Browser page
requests are intercepted, permitting only the four independently downloaded
fixture files; outbound requests and private host credentials are not available.
Requires Node 25+ for network-denying permission support and installed Chromium
or Chrome (optional `HARNESS_CHROME_EXECUTABLE`). It fails closed if unavailable.

## Safety and credentials

The runner reuses the sibling frontend's existing synthetic test account/site
configuration and verifies its owner/admin authorization. Supabase user tokens
perform fixture mutations; private service-role access only observes scoped
commands, actions and sessions. GitHub writes create **new test branches only** in
the previously selected `makinary/apps` test repository, never main or customer
branches. Vercel CLI credentials are loaded in memory to read scoped sandboxes
and verify the exact API production alias. Tokens are never serialized.

The run is capped at 12 observed credits, 20 minutes for admission, 10 minutes of
observed execution per case and 45 minutes total. Queue delay and execution are
reported separately; late admission never counts as a completed change.
Cases activate sequentially. Observation includes actual interactive and model
credits, plus any transactions from the configured test site in that interval
(conservative if another test runs concurrently). Sampling may overshoot the cap;
the budget is not a provider billing guarantee. Requirement budget is also finite.

Failure blocks remaining run-owned requirements and reports this as admission
blocked, **not** proof that in-flight provider operations were stopped. An aborted
SSE connection does not cancel a durable assistant workflow. Never replay an
ambiguous request. Inspect its trusted action and stop after the turn quiesces if
needed. Setup may leave a new isolated branch if a later insert fails; retain the
private run journal and inspect collisions before another run.

No migrations or API deployment are performed by this runner. It tests the exact
deployed code, whose deployment ID and Git SHA are recorded. No payments, outbound
communications, provisioning, app deployment or dependency installation is requested.
The repository's Git integration may automatically deploy previews on test-branch
pushes/checkpoints; a live run observed this even with no deployment tool request.
Review that integration before running. Such previews are side effects, not acceptance
evidence, and may consume provider resources.

## Commands

From `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`, with Node 25+:

```sh
npm run test:harness:e2e:live -- preflight live-app-YYYYMMDD-01 --ack-live-test
npm run test:harness:e2e:live -- run live-app-YYYYMMDD-01 --ack-live-test
npm run test:harness:e2e:live -- observe live-app-YYYYMMDD-01 --ack-live-test
npm run test:harness:e2e:live -- stop live-app-YYYYMMDD-01 --ack-live-test
npm run test:harness:e2e:live -- run live-app-YYYYMMDD-cart --ack-live-test --case quantity-subtotal
npm run test:harness:e2e:live -- run live-app-YYYYMMDD-filter --ack-live-test --case category-filter
```

Use a new ID for each execution; `.live-lock` deliberately prevents automatic
reruns, not read-only observation. Private reports are written under the frontend's
ignored `agent-test-reports/harness/<run>/` directory with mode 0600.
Selected-case runs report `fullThreeCaseSuite: false`; they cannot certify the full
three-case suite. Concurrent runs conservatively count all observed site transactions
against each watchdog. Only the unselected default run certifies all three together.

Exit 0 for **run/observe** requires all three actual requests to have a correlated
completed user action, applied newer command, same bound session, real successful
execution receipts and completed requirement/session. At terminal completion the
runner independently reads a pinned Git checkpoint and compares it against the
seed commit: only four approved fixture paths may change. Final downloaded source
must actually differ and pass every independent functional/preservation check.
An exec call or assistant statement alone never passes. Missing source checkpoint
or failed assertions remain failure even if the sandbox was suspended.

Preflight exit 0 is only readiness. Exit 1 is execution/evidence failure; exit 2 is
unavailable setup/preflight. Offline oracle tests validate the verifier, not live
agent delivery. Do not place this credentialed paid suite in ordinary pull-request
CI or label its offline tests as a live E2E pass.

## November 3 actual execution outcome

Authenticated live requests were submitted and real command application/cron
execution observed. **No full E2E pass is claimed.**

- `live-app-20261103-04`: landing CSS changed through real `exec`/`apply_patch`.
  Independent Chromium/source verification passed 14/14 checks, but the session
  stayed running after five turns and did not complete before its execution deadline.
- `live-app-20261103-cart`: actual cron admission failed with temporarily unavailable
  tool-screen permissions. Its mapping existed before a session row was created;
  the observer now treats that as pending evidence instead of throwing a missing-row
  implementation error. No subtotal change was independently verified.
- `live-app-20261103-filter`: real session paused after one turn with the persisted
  fixed diagnostic `boundary_failed`. No source change; only 12/16 baseline checks
  passed. This is failed execution, not functional delivery.

Run-owned requirements were blocked after failures. In-flight operations were not
claimed stopped and no ambiguous user request was replayed. Reported credits for
the concurrent selected cases overlap and must not be added as exact total charges.
Private reports contain session/requirement correlation and fixed assertion outcomes.
The deployed API still needs runtime investigation/fixes and a new passing live
run before these scenarios can be described as working reliably.