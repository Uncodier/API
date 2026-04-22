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
  matched_acceptance[], unmatched_acceptance[] }`.
- Implemented deterministically in
  `src/app/api/cron/shared/archetype-runner.ts:runJudge`.

## Hard rules

1. **Evidence-or-bust**. The Judge ignores free-text claims. It only
   approves when each acceptance entry has matching tool-call evidence
   (typed: build, test, runtime, scenario). The matcher is a 4+-character
   token AND-match against the haystack (tool names + outputs + signals).
2. **Per-flow guardrails (delegated)**:
   - app/site → build OK + runtime OK + scenarios OK.
   - doc/contract → markdown lint or remark tool-call present.
   - presentation → screenshot or capture tool-call per slide.
   - backend / `kind in (auth, crud, integration)` → at least one HTTP
     probe or test command.
   - automation → at least one runtime invocation (cron / webhook / run).
   - task / makinari → at least one tool-call.
3. **Escalation**. When `attempts ≥ 3` and acceptance is still unmatched
   the Judge returns `escalate` instead of `rejected`, so self-heal can
   downgrade the scope or log assumptions instead of looping.

## Outputs flow

- `approved` → runner marks the item `done`, pushes a checkpoint commit
  including the updated `evidence/<id>.json`.
- `rejected` → runner triggers `self-heal`: rotate strategy, downgrade
  scope, log assumption, or finally `mark_needs_review`.
- `escalate` → runner skips retry, advances `self-heal` straight to
  `log_assumption_and_continue` or `mark_needs_review`.

## Anti-patterns

- LLM-tone subjective approval. The Judge is rule-based; resist the urge to
  soften it.
- Approving with `unmatched_acceptance.length > 0`. Always `rejected` or
  `escalate`.
- Overriding flow rules per item. File a per-flow Judge variant skill (e.g.
  `makinari-rol-judge-app`) with the rule additions.
