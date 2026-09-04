---
name: makinari-rol-judge-doc
description: Judge variant for `doc` flow. Requires a markdown lint or remark tool-call before approving.
types: ['content']
---

# SKILL: makinari-rol-judge-doc

Per-flow Judge for `doc`. Required evidence:

- A tool-call whose name matches `/lint|markdown|remark/i` with non-failure
  exit code. Without it the verdict is `rejected: doc judge requires a
  lint/markdown tool call in evidence`.
- Acceptance tokens must appear in the evidence haystack (lint output,
  commit summary, claim).
- `unmatched_constraints`: if the spec declares MUST NOT / "sin outbound"
  rules and the deliverable (or evidence haystack) uses those forbidden
  terms, the verdict is `rejected` with the quote. Do not approve a doc
  that violates a hard constraint.

Implementation: `archetype-runner.ts:judgeDoc`. Add new rules by extending
that function, not by editing this skill body.
