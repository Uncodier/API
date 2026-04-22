---
name: requirement-author
description: Author and maintain the requirement "brain" — a persistent, testable blueprint that downstream roles (investigation, planning, frontend, backend, QA, devops) execute against. Use when creating or refining a requirement before a plan is built, when translating a business request into a technical contract, or when updating instructions mid-cycle.
types: ['planning', 'develop', 'automation', 'content', 'design', 'task', 'integration']
---

# Requirement Author

## Objective

Produce and maintain the `instructions` field of the requirement — the **single source of truth** that every other skill reads. A good requirement is:

- **Testable**: acceptance criteria can be mapped 1:1 to QA scenarios.
- **Bounded**: explicit non-goals prevent scope creep.
- **Contractual**: API, DB, env, and UI test ids are declared up front so frontend, backend, and QA agree.
- **Aware of its base**: suggests Vitrina vs generic app so `makinari-obj-template-selection` has a starting point.

## Instructions

### 1. Never ship a superficial requirement
Do not accept "clone X" or "make it nice". Translate the business request into concrete technical language. If the user request is ambiguous, surface the ambiguity in a **Questions** section at the bottom rather than guessing.

### 2. Use the Standard Structure
Every requirement must follow this structure. Sections marked **(required)** are mandatory.

```markdown
# Project: <Name>

## 1. Overview (required)
One short paragraph describing the product / feature from a client perspective.

## 2. Baseline (required)
Current state of the repository and the data this feature will touch.
- Repo / branch / key paths that already exist.
- Feature flags, env vars, DB tables this will read or mutate.

## 3. Goals (required)
Bullet list of the outcomes this cycle must achieve.

## 4. Non-Goals (required)
What is explicitly OUT of scope. If the plan drifts into these, stop.

## 5. Technical Guidelines (required)
- **Routing & Layouts:** Public vs private, protected routes, nested layouts.
- **Auth / Authz:** How sessions, tokens, roles are handled.
- **State & Data:** Context, Zustand, SWR, or direct API calls.
- **UI / UX:** Tailwind conventions, responsive breakpoints, accessibility floor.
- **Error Handling:** 404 pages, empty states, loading skeletons, retry policy.
- **Observability:** Where to log (`cron-audit-log` or equivalent) and what to log.

## 6. Contracts (required)
### 6.1 API contracts
For every endpoint touched:
- Method + path + `?mode=test` / `?mode=prod` support.
- Request JSON schema (fields, types, required/optional).
- Response JSON schema (success + error shapes).

### 6.2 DB changes
- New tables / columns / indexes with types and nullability.
- Migration strategy (idempotent SQL, rollback note).
- Whether existing rows are backfilled and how.

### 6.3 Env / secrets
- Any new env var: name, example value (masked), which surface uses it (server / edge / client).
- Note whether it must be added to `.env.local` and to Vercel.

### 6.4 UI test-id contract (required when UI is involved)
The frontend MUST expose these `data-testid` attributes. Renaming them after this point is a regression.
- `[data-testid="..."]` → element + purpose.

### 6.5 Seed QA scenarios (required when UI is involved)
Short list the QA role will turn into `.qa/scenarios/*.json`. One line per scenario: user action → expected outcome.

## 7. Acceptance Criteria (required)
Testable statements. Prefer Given/When/Then or concrete asserts.
- GIVEN <state> WHEN <action> THEN <observable outcome>
- The endpoint returns `200` with `{ok:true}` on test mode.
- The page renders `<h1>Title</h1>` at 1280x800 with no console errors.

## 8. Base Hint (required)
Suggest which base branch the orchestrator should pick in `makinari-obj-template-selection`:
- **Vitrina**: which one (text, gallery, slides, pdf, data, automation).
- **Generic app**: which baseline branch (`main`, `core-infrastructure`, etc.).
- Rationale: 1 line.

## 9. Execution Plan (checklist)
Granular checklist the planner will turn into `instance_plan` steps. Preserve `[x]` checks across updates.
### Phase 1 — Setup
- [ ] ...
### Phase 2 — Build
- [ ] ...
### Phase 3 — QA + Validate + Report
- [ ] ...

## 10. Definition of Ready (required gate)
Before the planner runs, confirm:
- [ ] Overview, Baseline, Goals, Non-Goals filled.
- [ ] Contracts section covers API / DB / Env / test-ids applicable to this work.
- [ ] Acceptance Criteria are testable and cover every Goal.
- [ ] Base Hint picked.

## 11. Open Questions (optional)
Bullet list of ambiguities the human must resolve. Block Definition of Ready if any are critical.
```

### 3. Where the requirement lives
- **Primary**: the `instructions` field on the requirement row. Update it via the `requirements` tool with `action="update"`. This is the only authoritative source.
- **Optional snapshot**: write `REQUIREMENT.md` at the repo root with `sandbox_write_file` for humans browsing the repo.

### 4. When updating an existing requirement
1. Read the current `instructions` first. Never overwrite blindly.
2. Preserve completed checkboxes (`[x]`) in the Execution Plan — they represent real prior progress.
3. Append new sections or refine existing ones. Do not re-order required sections.
4. If the client feedback changes the Contract (API shape, test-ids), add an entry to a `## Revisions` section at the bottom with date and summary so downstream skills can diff.

### 5. Handshake with downstream skills
- `makinari-fase-investigacion` expects section 2 "Baseline" to be grounded in the actual repo.
- `makinari-fase-planeacion` consumes sections 3, 4, 7, 8, 9 to build `instance_plan`.
- `makinari-rol-frontend` treats section 6.4 as **immutable contract** — test-ids cannot be renamed in code.
- `makinari-rol-qa` turns section 6.5 into `.qa/scenarios/*.json` and section 7 into per-step asserts.
- `makinari-rol-backend` implements section 6.1 (API) and 6.2 (DB) verbatim.

## Tools

| Tool | When to use |
| --- | --- |
| `requirements` | Primary. `action="read"` to load current instructions; `action="update" instructions="..."` to persist. |
| `sandbox_write_file` | Optional. Write `REQUIREMENT.md` snapshot at repo root. |
| `sandbox_read_file` | Read repo files when drafting the Baseline or Contracts sections. |
| `sandbox_list_files` | Explore existing structure before declaring the Baseline. |
| `memories` | Fetch brand context, prior decisions, and site settings. |

Prefer `requirements action="update"` over `sandbox_write_file` for persistence; the repo snapshot is advisory only.

## Artifacts

- **Produces**: `requirement.instructions` (brain, DB field). Optionally `REQUIREMENT.md` at the repo root.
- **Consumes**: `memories` for brand/tone, repo contents via `sandbox_read_file` / `sandbox_list_files` to verify the Baseline.

## Worked Example

```markdown
# Project: Landing page for Vitrina PDF report

## 1. Overview
Publish a PDF deliverable (quarterly report) via the PDF Vitrina so the client can share a link with their board.

## 2. Baseline
- Applications repo, Vitrina PDF branch already checked out.
- No existing client data in `src/app/data.json`.
- No env vars required.

## 3. Goals
- Host the PDF provided by the client at `/` with preview viewer.
- Show client name, report title, and publish date in the header.

## 4. Non-Goals
- No authentication, no download tracking, no comments.
- Do NOT add an email capture form.

## 5. Technical Guidelines
- Layout: single route `/`, no nested layout needed.
- Auth: none.
- State: static content from `src/app/data.json`.
- UI: Tailwind typography, mobile-first, min touch target 44px.
- Error: fall back to "Report not available" if PDF URL is missing.
- Observability: none beyond standard Vercel logs.

## 6. Contracts
### 6.1 API contracts
N/A (content-only Vitrina).
### 6.2 DB changes
N/A.
### 6.3 Env / secrets
N/A.
### 6.4 UI test-id contract
- `[data-testid="pdf-header"]` — header block with title + date.
- `[data-testid="pdf-viewer"]` — iframe or viewer wrapper.
- `[data-testid="pdf-fallback"]` — visible only when `pdfUrl` is empty.
### 6.5 Seed QA scenarios
- Given the page at `/`, when it loads at 1280x800, then `pdf-header` and `pdf-viewer` are visible.
- Given an empty `pdfUrl`, when the page renders, then `pdf-fallback` shows "Report not available".

## 7. Acceptance Criteria
- GIVEN a valid `pdfUrl` in `data.json` WHEN the user opens `/` THEN the viewer renders the PDF inline.
- No console errors at 1280x800 and 375x812.
- Lighthouse performance >= 80 on mobile.

## 8. Base Hint
Vitrina PDF — branch `feature/16ccdd2c-6636-4b38-a4fc-89ea2c9fe0cc`. Client wants a packaged deliverable, not a custom app.

## 9. Execution Plan
### Phase 1 — Setup
- [ ] Select base branch (template-selection).
- [ ] Read `src/app/data.json`.
### Phase 2 — Build
- [ ] Inject client content into `src/app/data.json`.
- [ ] Add `data-testid` attributes per section 6.4.
### Phase 3 — QA + Validate + Report
- [ ] Author `.qa/scenarios/pdf-render.json`.
- [ ] Build passes, visual gate passes at both viewports.
- [ ] Create `requirement_status` with preview URL.

## 10. Definition of Ready
- [x] Overview, Baseline, Goals, Non-Goals filled.
- [x] Contracts covered (UI test-ids + seed scenarios).
- [x] Acceptance Criteria testable.
- [x] Base Hint picked.
```

## 12. Backlog canonical (source of truth for progress)

Starting with the harness refactor, `## 9. Execution Plan` is a **read-only
render** of `feature_list.json` / `requirements.metadata.backlog`. You do NOT
track completion inside the requirement spec. Instead:

- When the spec is created, emit a matching set of `BacklogItem`s via the
  `requirement_backlog action="upsert"` tool. One item per deliverable, with
  `title`, `kind`, `phase_id`, `acceptance[]` and optional `touches[]`.
- The phase id must match the flow registry (`app`: base/investigate/build/qa/
  validate/report; `doc`: outline/draft/review/report; etc.).
- Keep acceptance observable — the Judge checks them 1:1 against
  `evidence/<item_id>.json`. Free-text acceptance is rejected.
- Section 9 of the spec is regenerated from the backlog; do not edit it by
  hand. The spec itself is an **immutable contract** — only `## Revisions`
  accepts new entries, and only when contract fields (6.x, 7) change.

## 12b. Uncodie Platform default (no third-party SDKs by default)

When the requirement needs email, WhatsApp, leads/CRM, notifications, agents,
analytics or in-app billing, **assume the Uncodie Platform SDK
(`/api/platform/*`)** unless the client explicitly asks for a third party.

- Section 6.3 (External services) lists `uncodie-platform` plus the scopes the
  generated app will use (e.g. `email.send.test-only`, `leads.read`,
  `notifications.create`, `tracking.event.write`).
- Section 7 (Acceptance) accepts platform calls as evidence (HTTP 2xx + audit
  log entry) — the Critic does NOT require a real provider account.
- If a capability is missing, file a backlog item `kind='integration'` so the
  Producer extends the platform instead of forcing a one-off third-party
  integration into the generated app.

## 13. Auth provider (apps / sites only)

When the requirement ships an app or site, set
`requirements.metadata.auth_provider`:

- `supabase` (default) — native Supabase Auth scoped to the tenant's schema.
  The sandbox injects `APPS_TENANT_JWT` and a `custom_access_token_hook` adds
  `tenant_id` to every issued JWT.
- `auth0` — only when the requirement explicitly asks for SSO corporativo or
  reuse of Uncodie users. Skill `makinari-obj-apps-supabase` documents the
  Auth0 adapter.

## Anti-patterns

- Writing a requirement without test-ids when a UI ships. QA will have to guess.
- Copying Goals into Acceptance Criteria verbatim. Goals describe intent; Acceptance Criteria describe observable outcomes.
- Treating "Execution Plan" as the only required section. Planning without contracts produces drift.
- Renaming contract fields mid-cycle without adding a `## Revisions` entry.
