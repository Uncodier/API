---
name: makinari-rol-judge-slides
description: Judge variant for `presentation` flow. Requires per-slide screenshot evidence and acceptance match before approving.
types: ['design']
---

# SKILL: makinari-rol-judge-slides

Per-flow Judge for `presentation` (reveal.js / spectacle). Required
evidence:

- Tool-call whose name matches `/screenshot|capture|reveal|spectacle/i`,
  one entry per slide.
- Acceptance tokens (e.g. number of slides, deck title, key sections)
  matched in the evidence haystack.

Failure modes: `rejected: slides judge requires per-slide screenshot
evidence` when the screenshot tool-call is missing.

Implementation lives in `archetype-runner.ts:judgeSlides`.
