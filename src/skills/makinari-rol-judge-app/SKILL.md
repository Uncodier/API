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
| `runtime`    | when item ships UI/route  | `http_status` outside 200-399                 |
| `scenarios`  | when QA scenarios exist   | any `pass = false`                            |
| acceptance   | always                    | any token-level mismatch in evidence haystack |

## Auto-rejection triggers (no LLM call)

- `evidence.build.exit_code !== 0` → `rejected: build gate failed`.
- `evidence.runtime.http_status >= 400 || < 200` → `rejected: runtime gate failed`.
- Any failing scenario → `rejected: scenario gate failed`.

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
