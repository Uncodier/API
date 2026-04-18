---
name: makinari-obj-template-selection
description: First-step playbook — choose the Git base (Vitrina branch vs generic app) from requirement type and client intent, then check out the correct branch in /vercel/sandbox before any feature work.
types: ['develop', 'content', 'design', 'automation', 'task', 'integration']
---

# SKILL: makinari-obj-template-selection

## Objective

Select **what to build on top of** in the **applications** repo already cloned at `/vercel/sandbox`. This step runs **before** content or frontend implementation. You **do not** implement product features here — only **decide**, **record**, and **align the working tree** with that decision via Git.

## Repositories (cron context)

- **Applications / vitrinas / generic web apps:** same GitHub repo (`GIT_APPLICATIONS_REPO`). The sandbox is already cloned; you only change **branch / baseline**.
- **Automation-only UI** (separate cron): `GIT_AUTOMATIONS_REPO` — if the requirement is clearly the automation runner vitrina in that repo, note it in `instructions` and skip applications-specific vitrina branches here.

## Decision matrix

### A — Use a **Vitrina** (packaged deliverable)

Use when the client wants a **fixed format** (articles, gallery, slides, PDF viewer, data table, webhook tester UI) and **not** a full custom SaaS/dashboard.

| Deliverable style | Base branch (exact) |
| --- | --- |
| Text / strategy / long-form (Notion-like, Markdown) | `feature/9be0a6a2-5567-41bf-ad06-cb4014f0faf2/424cc56d-510e-4bbf-a4e1-aa2e30700325` |
| Media / design (galleries, icons, video links by category) | `feature/9be0a6a2-5567-41bf-ad06-cb4014f0faf2/512ceb6a-f133-4716-9a10-0d2a008c10ed` |
| Commercial decks / pitch / slides | `feature/ce1b2fec-3455-49a1-a35d-54671c00d00d` |
| PDF documents (interactive viewer) | `feature/16ccdd2c-6636-4b38-a4fc-89ea2c9fe0cc` |
| Data / analytics (heavy tables, CSV/JSON) | `feature/6e819746-5da2-4e3a-8192-0a592dff99cc` |
| Automation runner / webhook tester UI | `feature/c3dcbbab-585a-46e9-b320-19b149a24aa0` |

### B — **Generic application** (custom SaaS, dashboards, clones, platforms)

Use when the requirement is **full product development**, not a single packaged vitrina shell.

- Prefer an **existing app baseline**: check out `main`, or a team baseline such as `core-infrastructure`, or another branch named in `requirement.instructions`.
- **Do not** create a second Next.js project under a nested folder. The platform expects **one** repo root at `/vercel/sandbox` with `package.json` at the root and routes under `src/app/`.
- **Do not** run `npx create-next-app` unless `instructions` explicitly require a greenfield and the repo is empty — default is to **extend** the checked-out baseline.

## Required actions (executor)

1. Read `requirement.instructions` and the requirement **type**; map to **A (vitrina)** or **B (generic)** with a one-line rationale.
2. **Git** (from `/vercel/sandbox`):
   - `git fetch origin`
   - For **A**: `git checkout -B feature/<requirement_short_id> origin/<vitrina_branch_above>` (use the real requirement id segment the workflow uses for feature branches if already established; otherwise create `feature/<reqId prefix>/...` consistent with existing remote branches).
   - For **B**: `git checkout` the agreed baseline (`main` or `core-infrastructure` or branch named in instructions), then create/switch to the feature branch for this requirement if the workflow already defines one.
3. Confirm the tree: `sandbox_list_files` on `.` — expect root `package.json`, `src/app/` layout consistent with the choice.
4. **Persist the decision** via `requirements` `action="update"`: append a short bullet to `instructions` such as `BASE: Vitrina <name> → branch <branch>` or `BASE: Generic app → branch <branch>`.
5. Optionally `requirement_status` with message summarizing base selection for humans.
6. Call **`sandbox_push_checkpoint`** if you changed files that must survive (e.g. only if you committed locally — normally the workflow checkpoints after steps; follow the checkpoint prompt). If you only ran checkout with no file edits, checkpoint may be unnecessary — follow platform checkpoint rules.

## Handoff

- After this step, **vitrina content work** follows **`makinari-obj-vitrinas`** (data injection, demo removal).
- **Generic app** work follows **`makinari-rol-frontend`** / backend skills without vitrina-specific templates.

## Anti-patterns

- Skipping this step and building on the wrong default branch.
- Mixing vitrina templates with “generic SaaS” in the same requirement without an explicit client decision.
- Creating `app/` or `apps/` at repo root for routes — routes belong in **`src/app/`** only.
