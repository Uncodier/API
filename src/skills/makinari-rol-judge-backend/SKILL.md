---
name: makinari-rol-judge-backend
description: Judge variant for backend-shaped items (`kind` ∈ {auth, crud, integration}) regardless of flow. Requires an HTTP probe or test command in evidence.
types: ['develop', 'integration']
---

# SKILL: makinari-rol-judge-backend

Backend Judge override. Triggered by `BacklogItem.kind ∈ { auth, crud,
integration }` even when the flow is `app` or `site`. The Judge requires:

- A tool-call whose name matches `/curl|fetch|http|test/i` with success
  exit code.
- Acceptance tokens matched against the haystack.

Failure mode: `rejected: backend judge requires an HTTP probe or test run`.

Implementation: `archetype-runner.ts:judgeBackend`.
