# Credit exhaustion: cycle termination and visible notice

## Verified incident

- Instance `dc06757e-5570-485c-9948-cf5bb9179ae8` had a confirmed rejected
  deduction: required `0.030699`, available `0.023545` credits. The remaining
  balance passed the former `0.001` admission check, so more turns could run.
- The stored included-plan period ends on **2026-11-01 at 00:00 UTC**.
- The instance was paused through the existing service-role application client.
  A visible, non-streaming `agent_action` notice was inserted with event
  `credits_exhausted` and that stored renewal date. Read-back confirmed
  `status=paused` and the requirement's cron slot inactive.
- Plans, backlog, budgets, generation, and requirement completion were not changed.
  No migrations, commits, pushes, or deployment were performed.

## Backend correction

- Credit admission distinguishes confirmed insufficient balance from unavailable
  billing. Outages and malformed balances do not produce an exhaustion claim.
- Assistant token deduction rejection is no longer swallowed. Cron single turns,
  coordinator, and wrap-up return a typed billing halt; interactive turns carry
  it across the durable boundary without losing the error identity to retries.
- Billing halts pause execution, not fail or complete product steps, create
  infrastructure retries, or spawn another assistant continuation.
- Cron cleans up its owned sandbox and releases its slot. Its exhaustion notice
  does not call an LLM and is emitted after sandbox cleanup. Pausing is not proof
  of sandbox shutdown; shutdown failure retains the existing diagnostic behavior.
- Notice writes are scoped to the instance/site; interactive actions retain CAS
  generation guards, and cron rechecks its original execution identity after
  reading billing. Retries reuse the visible event notice.
- Only a valid future stored period end with an eligible active allowance is
  shown. Stripe renewal is explicitly conditional on payment; unknown dates are
  not guessed. The notice preserves a nonzero remaining balance.
- Assistant SSE returns `INSUFFICIENT_CREDITS`, the explanation, and
  `next_credit_reset_at`, then closes instead of reporting generic incompletion.

## Rollout

The incident's pause and message are already persisted. General automatic behavior
requires deployment of this API change through the normal release process.
Renewing credits does not authorize an automatic restart: the existing resume
path must be used. No new database schema is required.

Tests are offline with mocked billing, sandbox, notification, and workflow I/O.
They do not claim browser verification or a deployed end-to-end credit failure.

The assistant Workflow plugin compilation passes without server database imports.
Cron Workflow plugin compilation also passes; its existing database import is
present in both the baseline and current workflow and is outside this correction.
TypeScript reports three existing errors in migration-retirement/credit-precision
test files, with none in files changed for this incident.

Validation: harness **192 suites / 3,010 tests passed**; billing **7 suites /
176 tests passed**; node continuation/recovery/compiler **3 suites / 53 tests
passed**; assistant private-context **5 tests passed**. `git diff --check` passed.