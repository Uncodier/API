---
name: makinari-rol-judge
description: Generic Judge archetype. Single-shot verdict on a backlog item using its evidence + acceptance. Returns one of {approved, rejected, escalate}. Per-flow specifics live in makinari-rol-judge-<flow>.
types: ['develop', 'content', 'design', 'automation', 'task', 'integration']
---

# SKILL: makinari-rol-judge

## Objective

Decide whether a backlog item is **done**. The Judge runs **once** per item
per cycle, after the gate technical checks and the Critic suggestions have
been processed. Its verdict drives self-heal and item status transitions.

## Operating contract

- Input: `{ item: BacklogItem, evidence: EvidenceRecord, flow }`.
- Output: `{ verdict: 'approved' | 'rejected' | 'escalate', reason,
  matched_acceptance[], unmatched_acceptance[], failure_kind? }`.
- Implemented deterministically in
  `src/app/api/cron/shared/archetype-runner.ts:runJudge`.

## Hard rules

1. **Typed proof, not tool-call counting**. Match acceptance against the
   strongest available receipt:
   - file criteria → a non-empty artifact proof or a present declared touch;
   - route criteria → a passing exact probe, or the route artifact plus a
     route-relevant passing test;
   - behavioral criteria → current passing test/runtime/scenario receipts.
   Free-text claims alone never prove completion.
2. **Per-flow guardrails (delegated)**:
   - app/site → build OK + runtime OK + scenarios OK.
   - doc/contract → markdown lint or remark tool-call present.
   - presentation → screenshot or capture tool-call per slide.
   - backend / `kind in (auth, crud, integration)` → at least one HTTP
     probe or test command.
   - automation → at least one runtime invocation (cron / webhook / run).
   - task / makinari → at least one tool-call.
3. **Typed failure**. Missing proof is `failure_kind='evidence_gap'`;
   malformed or narrative-only acceptance is `contract_error`; an observed
   broken behavior is `product_defect`.
4. **Attempt accounting**. Evidence and contract gaps do not consume product
   attempts and cannot independently force `needs_review`. Product defects
   still use the bounded self-heal policy.
5. **Step-scoped adjudication**. A no-progress adjudication evaluates only
   the current step contract. It must not reject the step for acceptance
   intentionally assigned to later steps.

## Outputs flow

- `approved` → runner marks the item `done`, pushes a checkpoint commit
  including the updated `evidence/<id>.json`.
- `rejected/escalate` + `product_defect` → runner triggers bounded
  self-heal and may eventually mark the item `needs_review`.
- `rejected/escalate` + `evidence_gap` → collect a current receipt without
  charging the product attempt budget.
- `rejected/escalate` + `contract_error` → repair the acceptance contract
  without charging the product attempt budget.

## Anti-patterns

- Approving because a tool was called. The receipt must prove the criterion.
- Rejecting because a receipt is represented as an artifact or relevant test
  instead of a literal route probe.
- Approving with `unmatched_acceptance.length > 0`. Always `rejected` or
  `escalate`.
- Overriding flow rules per item. File a per-flow Judge variant skill (e.g.
  `makinari-rol-judge-app`) with the rule additions.
