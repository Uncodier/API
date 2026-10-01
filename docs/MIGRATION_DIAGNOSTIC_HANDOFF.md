# Evidence-based migration diagnosis and bounded handoff

## Behavior

Migration exhaustion means **unresolved automatically**, not irreparable. The
existing `attempts` field remains a historical assignment/review budget (0–5).
It is not renamed, reset, or retroactively interpreted as five executed repairs.

For a runnable `correction_required` migration at that limit, the scheduler:

1. Provisions/attaches the normal requirement workspace before diagnosis.
2. Atomically claims one independent diagnostic per requirement and file.
3. Runs a new conversation with at most three model turns and eight restricted
   source reads. It has no write, shell, SQL application, or status tools.
4. Validates its structured verdict against host-collected migration/specification
   evidence and verified capabilities. Unknown evidence and invented product
   decisions do not create authority.
5. Persists a different, testable repair hypothesis as a single follow-up on the
   existing implementation plan, then acknowledges the durable assignment. The
   next normal worker executes it; no new queue or customer approval is required.
6. Allows only that assigned, changed proposal to enter one fresh central security
   review. Original attempts stay at five. Passing review still requires the
   normal atomic SQL receipt and fresh product/authorization verification.

The diagnostic allowance and follow-up review cannot be reclaimed by elapsed
time, a new workflow, a new generation, or generic "repair/apply/continue" input.
An interrupted diagnostic stays accounted for; it is never silently replayed.
Plan assignment failure does not acknowledge a follow-up. A persisted ready result
can be assigned again idempotently without running another diagnostic.

## Verdicts

- `repair_candidate`: evidence-backed hypothesis and concrete implementation/test
  instructions, not an application approval or evidence of success.
- `missing_capability`: currently only host-confirmed unavailable storage can be
  classified automatically. Other unverified prerequisites remain unresolved.
- `needs_product_decision`: only an exact supplied canonical pending choice may
  qualify. Current diagnostic runtime supplies none; it cannot invent a question.
- `constraint_conflict`: requires specification and capability evidence plus
  alternatives. It is a conditional diagnostic claim, not universal impossibility.
- `unresolved`: insufficient evidence or exhausted automatic recovery. Includes
  the next required check rather than a generic request for repair permission.

Genuine security holds, changed reviewed content, uncertain applied writes, and
missing ledger evidence remain protected by the original lifecycle. This feature
does not bypass them or automatically reopen pre-existing `platform_review` rows.
If no usable follow-up exists, an owner-checked transaction records the hold,
settles the linked plan/instance, and publishes the diagnostic reason. It preserves
other files' receipts and cannot undo a manual pause or another executor's state.

## Rollout and limits

Apply the forward migration
`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261001053000_migration_diagnostic_handoff.sql`
to **Makinari**, not Apps, before deploying these callers. It adds the diagnostic
receipt table and service-only scoped RPCs; it does not edit the original migration
or reset historical records. Missing persistence fails closed.

Drain existing workers when deploying the coordinated API changes. Existing
blocked instances require explicit technical reconciliation of their receipts;
deployment does not resume them. A source file not available after workspace
recovery is insufficient evidence, not permission to reconstruct an applied file.

This implementation does not replace the legacy budget with execution-receipt
accounting, create a general operator queue, auto-provision missing external
capabilities, or infer answers to product decisions. Those are separate concerns.

Validation: `npm run test:harness` includes diagnostic policy/model isolation,
workflow handoff, central review, and isolated PGlite tests for permissions, CAS,
one-time consumption, rollback, terminal settlement and resume denial. No live
customer migration or production workflow is exercised by these tests.