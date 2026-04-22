---
name: makinari-rol-critic
description: Generic Critic archetype. Reviews a backlog item's artefact + evidence and emits suggestions[]. Bounded to 2 iterations. Has NO authority to mark items done — that is the Judge's job.
types: ['develop', 'content', 'design', 'automation', 'task', 'integration']
---

# SKILL: makinari-rol-critic

## Objective

Inspect a single backlog item plus its `EvidenceRecord` and return a list of
suggestions the Consumer can act on. The Critic is a **suggestion source**,
not a gate. The runner enforces a hard limit of two Critic passes per item.

## Operating contract

- Input: `{ item: BacklogItem, evidence: EvidenceRecord, flow }`.
- Output: `CriticSuggestion[]` with fields `{ rule, severity, fix_hint }`.
- Severity levels: `blocker` (Consumer must fix), `major` (Consumer should
  fix), `minor` (FYI, no retry triggered).
- The Critic is implemented as a deterministic pass in
  `src/app/api/cron/shared/archetype-runner.ts:runCritic`. Skill authors do
  not write LLM prompts — they file new rules in that module.

## Required behaviour

1. Read `item.acceptance[]`. Without acceptance there is nothing to critique.
   Emit `no-acceptance` blocker so Producer fixes the spec.
2. Read `evidence.tests`, `evidence.build`, `evidence.runtime`,
   `evidence.scenarios`. Anything missing for the flow is a `blocker` or
   `major` suggestion (e.g. apps without build → blocker).
3. Read the commit summary. If only `*.md` / `progress.md` / `evidence/*`
   were touched, raise `admin-only-commit` (major).
4. Never invent issues that are not derivable from inputs. If the rules
   produce nothing, return `{ ok: true, suggestions: [] }`.

## Bounded iteration

The runner calls `runCritic` once per pass and feeds the suggestions back to
the Consumer. After two passes it stops, regardless of remaining
suggestions, and hands control to the Judge. This bounded loop is hard-coded
in `inline-step-executor.ts`.

## Anti-patterns

- Trying to mark the item done. The Critic CANNOT change `item.status`.
- Emitting subjective taste critiques without a rule. Each suggestion must
  carry a `rule` id that exists in the runner.
- Echoing the spec back. The Critic compares evidence against acceptance —
  it does not paraphrase the spec.
