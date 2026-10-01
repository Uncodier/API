# Technical verification exhaustion is not customer approval

## Behavior

- Exhausted attempts, review quarantine and synthetic dependency blockers no
  longer imply a customer decision. Independent runnable work remains runnable.
- The scheduler's coarse budget circuit requests internal review. The workflow
  routes terminal backlog verification to review without creating another plan
  or sandbox. Budgets, acceptance, quarantine and SQL/security checks are unchanged.
- Legacy `requiresUserFeedback`/`blocked` reporting is reconciled against current
  user-owned `user_decision`/`missing_precondition` blockers, or an independently
  validated host product-decision receipt. Prose and counters are not authority.
  Unavailable decision state keeps reporting failed and the requirement paused;
  it is not treated as proof that no customer prerequisite exists.
  A real customer prerequisite and an exhausted technical quarantine can coexist:
  report the specific question and persist the technical ticket; the reply cannot
  release the independent technical hold.
- The host attempts technical escalation after persisting `blocked`, before
  loading reporting history or invoking the model. It uses the existing
  `record_harness_diagnostic_decision` RPC and support delivery service. Stable
  request IDs bind requirement, instance and execution generation, not reporting
  timestamps. Replayed reporting reuses its ticket; uncertain email is not resent.
- Missing ticket storage remains a failed reporting outcome; it never reopens
  execution. Missing email configuration still permits a recorded ticket. The
  prompt receives separate persistence/delivery facts and cannot claim that a
  reviewer or repair is active merely because the ticket exists.
- Reporting has read-only diagnostic tools, not `harness_decide`, mutation tools
  or extra repair authority. Cron-owned calls retain ownership checks at dispatch.

## HTTP fixture diagnosis

Inspection now includes persisted step `validation_targets`, `test_command`,
retry count and `repair_run` with existing redaction/response limits. The source
allowlist includes runtime probe and wrap-up policy implementations.

An unexpected HTTP 500 still fails validation. A success-case fixture must match
the actual endpoint schema and seed any required related records; random UUIDs
alone may not suffice. A deliberately invalid UUID belongs in a negative test
with the contract's client-error expectation. No payload is silently rewritten,
no schema/UUID validation is disabled, and test expectations are not relaxed.
A stored plan fixture is separate from a repository fixture.

The reported `/api/webhooks/makinari` implementation and its `"123"` fixture are
not in this API repository. Correct that exact fixture in the owning requirement
after inspecting canonical evidence; this change does not repair customer code,
release its hold, reset its counters or schedule another product attempt.

## Deployment and validation

This uses the branch's existing prerequisite migration:

`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261001220000_harness_diagnostic_decisions.sql`

Apply it to Makinari through the normal release process before deploying the API.
Configure `HARNESS_SUPPORT_EMAIL` (or the existing fallback) and SendGrid for email
delivery. No additional migration or automatic historical backfill is introduced.
Already blocked requirements are not automatically reactivated or revisited.

Run `npm run test:harness` from
`/Users/prado/Desktop/Proyectos/Uncodie/Code/API` using Node 22. Regressions cover
strict UUID negative-test expectations, technical versus customer classification,
coarse budget routing, reporting before model failure, read-only dispatch,
idempotent ticket storage and delivery failures. Tests use offline mocks/PGlite;
they do not send email, apply customer SQL, or prove a production rollout.

Local validation: **159 suites / 2,204 tests passed**, plus six existing blocker
tests outside the harness config. `next build --webpack --experimental-build-mode
compile` completed with existing dependency/deprecation warnings (compilation,
not a full prerender/delivery verification). Both assistant and durable-step
traces include all 37 allowlisted sources. Focused TypeScript diagnostics were
zero in 15 changed source/test files, with generated `.next` files excluded;
the repository-wide type check is not clean (unrelated and generated errors).