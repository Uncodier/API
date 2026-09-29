# Internal security review, not generic customer approval

## Scope

Tenant migration failures no longer imply `requiresUserFeedback=true`. The
workflow uses `internal_review` for unresolved technical failures and failed
fresh product verification. It persists the blocked transition through the
existing generation-guarded atomic blocker before attempting client reporting.
No database migration or new privileged RPC is needed for this harness change.

## Independent reviewer

Eligible pending SQL replacements go through a fresh, read-only security-agent
conversation. The only reviewer tool submits a structured verdict:

- `approved_for_validation`: eligible for the existing checks, not an applied receipt.
- `request_changes`: corrective feedback to the repair agent within its budget.
- `platform_review`: remain blocked for technical platform intervention.
- `needs_product_decision`: a concrete question and options about an unresolved
  product/access decision, grounded in an excerpt of the requirement specification.

The repair executor cannot submit its own reviewer verdict. The reviewer cannot
write files, run SQL, change status, access secrets, or bypass the deterministic
linter/repair boundary. Missing, malformed, conflicting or prose-only verdicts
do not authorize writes. Missing or oversized review context fails closed.

The executor and reviewer share at most five model calls across pending files.
The final available call is reserved for read-only triage. The durable repair
step still has automatic replay disabled. A provider/transport failure does not
authorize applying SQL or reporting delivery.

## Preserved boundaries

- Only a verified, unapplied migration can be replaced.
- Tenant identity, applied-history eligibility, canonical path, checksum and
  execution ownership are checked again after asynchronous review.
- The specification must still match the version reviewed before a write.
- Source paths survive individual repair turns, are re-read for independent
  review and checked again before writing. Source history resets between targets.
- Non-policy SQL, policy identities, commands and roles remain protected by the
  existing conservative repair boundary. Dynamic SQL rewrites, structural
  changes, data backfills and policy removal are **not** newly authorized.
- Atomic migration application and fresh product verification still run after
  a replacement. Lint and a model's approval are not proof of authorization.

## Customer-facing behavior

`internal_review` keeps the requirement blocked even when queued plan work or
older successful evidence exists. It overrides a conflicting feedback flag.
Status writes from the wrap-up agent cannot resume or complete it. Client
messages describe the paused update without raw SQL diagnostics or a generic
request to authorize routine repairs. Only a concrete product-decision verdict
asks the customer a question.

Technical review is recorded in the existing infrastructure audit event with
`security_review`, `resolution_actor`, `user_action_required` and `turns_used`.
There is no new platform-operator work queue or automatic operator-resume path
in this change. A `platform_review` verdict means intervention is required;
messages must not claim a human review is assigned or scheduled. Existing
already-blocked requirements are not automatically reopened by deployment.
An ambiguous write or unavailable verification after a repair also remains on
internal hold, even when its accounting classification is infrastructure. It must
not enter a new normal cycle without fresh validation of changed authorization.

## Guidance and validation

The backend skill now uses static tenant-local examples, provisioned identity
helpers, protected membership and no production dummy-data requirement. Its SQL
fences are checked against the real linter for multiple schemas in the offline
harness suite, alongside the canonical Supabase skill examples.

Run `npm run test:harness` from
`/Users/prado/Desktop/Proyectos/Uncodie/Code/API`. Regression coverage includes
reviewer verdict validation, no privilege bypass, concurrent replacement refusal,
post-review ledger/file/specification changes, budget accounting, concrete
product questions, blocked-state persistence and safe client reporting.

This change is local until the API is deployed. It does not apply customer SQL
or validate a live tenant/application end to end.

Local validation: **122 suites / 1,315 tests passed** in the full offline harness.
The focused migration/security/workflow rerun also passed (7 suites / 191 tests).
Repository-wide TypeScript still reports errors outside the files changed for
this feature; this is not a claim of a successful production build.