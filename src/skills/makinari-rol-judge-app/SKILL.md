---
name: makinari-rol-judge-app
description: Judge variant for `app` and `site` flows. Hard-checks build + runtime + scenarios + acceptance-evidence match before approving an item.
types: ['develop']
---

# SKILL: makinari-rol-judge-app

Implements the per-flow extension for `app` / `site`. The generic Judge
delegates to this rule pack when `flow ∈ { app, site }`.

## Required signals in `evidence`

| Signal       | Required                  | Rejected when                                 |
| ------------ | ------------------------- | --------------------------------------------- |
| `build`      | always                    | `exit_code != 0`                              |
| `runtime`    | for explicit contract targets | a required target has a hard-fail disposition |
| `scenarios`  | when QA scenarios exist   | any `pass = false`                            |
| acceptance   | always                    | no typed artifact, route, test, or runtime proof |

## Auto-rejection triggers (no LLM call)

- `evidence.build.exit_code !== 0` → `rejected: build gate failed`.
- A required runtime observation with `disposition=hard_fail` → `rejected: runtime gate failed`.
- Any failing scenario → `rejected: scenario gate failed`.

Advisory or unknown inferred probes never become product failures. A missing
preview URL, unavailable visual critic, or deployment transport failure is an
infrastructure/precondition result and does not consume product attempts.

## Corroborating proof

- A page/API route can be proven by an exact passing probe.
- When an exact probe cannot safely execute (for example a mutation needs
  payload), the route file plus a current route-relevant passing test is
  sufficient.
- A declared non-empty document or source artifact proves file-creation
  acceptance without requiring the tool-call text to contain the word
  "creates".

## Approval template

```jsonc
{
  "verdict": "approved",
  "reason": "all acceptance entries matched in evidence",
  "matched_acceptance": ["..."],
  "unmatched_acceptance": []
}
```

## Notes

The runner enforces these rules at
`src/app/api/cron/shared/archetype-runner.ts:judgeApp`. Skill authors extend
it via additional rule functions invoked from `judgeApp` — never via
free-form prose.
