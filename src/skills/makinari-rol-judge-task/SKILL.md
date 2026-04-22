---
name: makinari-rol-judge-task
description: Judge variant for `task` and `makinari` flows. Requires at least one tool-call plus acceptance match.
types: ['task', 'automation']
---

# SKILL: makinari-rol-judge-task

Per-flow Judge for `task` and `makinari`. The minimal contract is:

- ≥1 tool-call recorded in evidence (any kind: build, test, runtime,
  scenario or generic).
- Acceptance tokens matched against the haystack.

Failure mode: `rejected: task judge requires at least one tool-call`.

For `automation` requirements see `makinari-rol-judge-backend` style
expectations: at least one runtime invocation tool-call (cron, webhook,
script run). Implementation: `archetype-runner.ts:judgeAutomation`.
