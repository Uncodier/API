---
name: makinari-rol-judge-contract
description: Judge variant for `contract` flow. Rejects unresolved {{placeholders}} and requires acceptance match.
types: ['content', 'task']
---

# SKILL: makinari-rol-judge-contract

Per-flow Judge for `contract`. The verdict is `rejected: contract still has
unresolved {{placeholders}}` whenever the evidence claim still contains
`{{ ... }}` tokens.

Acceptance entries are matched against the evidence haystack; standard
escalation kicks in after `attempts ≥ 3`.

Implementation: `archetype-runner.ts:judgeContract`.
