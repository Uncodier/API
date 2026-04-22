---
name: makinari-agents-md
description: Generates the canonical AGENTS.md for the current flow type. Run once at bootstrap of a new branch / new requirement so every subsequent consumer step reads from a stable operating manual instead of a mega-instructions blob.
types: ['bootstrap', 'develop', 'automation', 'task', 'content', 'design', 'integration', 'planning']
---

# SKILL: makinari-agents-md

## Objective

Write a single `AGENTS.md` in the repo root that operationalises the harness
principles for the active flow type. This file is **read-mostly** — sibling
skills should never overwrite it; if a new convention emerges, append a scoped
section at the bottom rather than rewriting the whole document.

The file is the operating manual of the repository, not a spec or a backlog.
The spec is `requirement.spec.md`; the backlog is `feature_list.json`; the log
is `progress.md`.

## When to run

- First cycle of a new branch (no `AGENTS.md` in `git ls-files`).
- When the orchestrator switches the flow type (e.g. an `app` requirement was
  re-scoped to `automation`). Preserve previous content under a collapsed
  `## Legacy` section before writing the new canonical body.

Never run this skill when `AGENTS.md` already matches the target flow — it
would produce a no-op diff and pollute `git log`.

## Template (one file, ≤300 lines)

```markdown
# AGENTS.md

Operating manual for this repository. Read before touching code or writing
ground-truth files.

## 1. Ground-truth files (single source of truth)
- `requirement.spec.md`   — immutable contract (overview, goals, non-goals,
  guidelines, section 6 contracts, section 7 acceptance, section 8 base hint).
  Append only to `## Revisions` when contract fields change.
- `feature_list.json`     — backlog. Mirror of `requirements.metadata.backlog`.
  Only the `requirement_backlog` tool mutates it; humans read, agents read.
- `progress.md`           — session log. One append per cycle. Summary + next.
- `DECISIONS.md`          — append-only architecture decisions + assumptions.
- `evidence/<item>.json`  — structured evidence per backlog item. Built by the
  consumer, verified by the critic, judged by the judge.

## 2. WIP = 1
Exactly one backlog item is `in_progress` per requirement. Producer decides
the next pending item; Consumer executes it; Critic suggests (bounded 2);
Judge decides (single-shot). Do not open a second item while one is active —
`requirement_backlog action='start'` will reject.

## 3. Evidence contract
The Judge only approves an item when `evidence/<item>.json` contains tool-call
traces that match the claim (e.g. `npm test` ran, `npm run build` exited 0,
HTTP 200 on the target route). Free-text claims without a matching tool-call
are ignored. Write evidence before marking `critic_review` — the runner will
not schedule the Critic otherwise.

## 4. Typed gates per flow
Flow-specific gates live in `src/app/api/cron/shared/gates/` in the Uncodie
API repo. For apps/sites the gate enforces build + runtime + console + QA
scenarios. For docs, markdown lint + broken-link check. For slides, per-slide
screenshot + word budget. For contracts, placeholder resolution + signature.
Do not implement ad-hoc validators — the gate is already wired.

## 5. Standard libraries per flow type
- app / site         → ShadCN + Tailwind + Radix + lucide-react.
- doc / contract     → MDX + remark.
- presentation       → reveal.js (or spectacle — documented per project).
- automation / task  → no UI kit; produce artefacts (report, script,
  markdown dashboard).

Raw `<button>`, `<input>`, `<select>`, `<dialog>` are rejected by the
app/site gate when an `@/components/ui/*` equivalent exists.

## 6. Uncodie Platform API (capability gateway)
Pre-provisioned endpoints under `/api/platform/*` in the Uncodie API expose
email, WhatsApp, leads, notifications, tracking and agents as authenticated
HTTP capabilities. The API key is injected at runtime in `UNCODIE_API_KEY`;
the SDK under `src/lib/uncodie/` wraps the fetches. Never provision third
parties (Resend / Twilio / Stripe / Supabase ajenos) unless the requirement
explicitly asks for it — default to the platform SDK.

All platform keys are `test-only` by default. Promote-to-production is a
manual action by the site owner from the Uncodie dashboard.

## 7. Apps Supabase (DB + Auth per tenant)
Each requirement owns a schema `app_<requirementId>` inside the shared Apps
Supabase project. Server-only `APPS_TENANT_JWT` gives write access to that
schema; browser clients use `NEXT_PUBLIC_APPS_SUPABASE_*` plus
`NEXT_PUBLIC_APPS_TENANT_SCHEMA`. Migrations go through the migration-linter
via `/api/platform/db/migrations` — never apply SQL directly with the service
key from inside the generated app.

## 8. Tools (by archetype)
| Archetype   | Example skills                                         |
| ----------- | ------------------------------------------------------ |
| Producer    | requirement-author, makinari-fase-planeacion           |
| Consumer    | makinari-rol-frontend/-backend/-content/-devops/-qa    |
| Coordinator | makinari-rol-orchestrator                              |
| Critic      | makinari-rol-critic                                    |
| Judge       | makinari-rol-judge (+ judge-app/doc/slides/...)        |

## 9. Loop detectors (hard rules)
- Planning loop: ≥8 tool calls with <10% writes → current turn is cut and the
  orchestrator injects a STOP feedback.
- Action loop: same command repeated 3+ times at ≥60% of the turn → skip
  retry, jump to self-heal.
- Admin loop: ≥2 consecutive cycles touching only `*.md` / `progress.md` /
  `evidence/*` → item is flagged `needs_review` and scope downgraded on the
  next cycle.

## 10. Cost envelopes
`max_turns_per_step`, `max_cycles_per_item`, `max_cycles_per_requirement` are
configured by `FlowDefinition`. When exhausted the runner escalates:
rotate_strategy → downgrade_scope → log_assumption_and_continue →
mark_needs_review. No blocking on human input — `needs_review` is an
informative label, not a handoff.

## 11. Init ritual
`./init.sh` (or the equivalent step in `src/app/api/cron/shared/*`) runs on
every cycle. It verifies `node_modules`, `.env.local`, baseline tests and
`git status`. Do not reimplement inside skills — read the init output from
the prior turn instead.

## 12. Commits
Every commit includes up-to-date `progress.md` and (when relevant)
`feature_list.json` + `evidence/*.json`. Code-only commits touching `src/**`
count as progress; commits touching only `*.md` / `evidence/*` are checkpoint
commits (not counted towards item advancement).
```

## Flow-specific overrides

When the flow is NOT `app`, replace sections 4, 5 and 6 with the relevant
standard library and acceptance hints. Keep 1-3 and 8-12 unchanged — those are
invariant across flows.

## Anti-patterns

- Writing AGENTS.md per requirement. It is per-flow, not per-requirement.
- Packaging the backlog or the spec inside AGENTS.md. They live in their own
  files by design (Principle 4 — split instructions).
- Rewriting AGENTS.md every cycle. It only changes when the flow changes.
- Removing sections. If a section becomes irrelevant, shrink it to one line;
  do not delete (future flows may reintroduce it).
