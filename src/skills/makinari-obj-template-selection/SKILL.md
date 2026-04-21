---
name: makinari-obj-template-selection
description: First-step playbook. Decide the Git base (Vitrina branch vs generic app) from the requirement type and client intent, record the choice in `instructions`, and align the working tree before any feature work.
types: ['develop', 'content', 'design', 'automation', 'task', 'integration']
---

# SKILL: makinari-obj-template-selection

## Objective

Select **what to build on top of** in the applications repo already cloned at `/vercel/sandbox`. This step runs **before** any content or feature work. You do NOT implement features here — you only decide, record the decision, and align the working tree with Git.

## Repositories (cron context)

- **Applications / Vitrinas / generic web apps**: single GitHub repo (`GIT_APPLICATIONS_REPO`). The sandbox is already cloned; you only change branch / baseline.
- **Automation-only UI** (separate cron): `GIT_AUTOMATIONS_REPO`. If the requirement is clearly the automation runner vitrina in that repo, note it in `instructions` and skip applications-specific vitrina branches here.

## Decision matrix

### A — Use a Vitrina (packaged deliverable)

Pick Vitrina when the client wants a **fixed format** (articles, gallery, slides, PDF viewer, data table, webhook tester UI) and NOT a custom SaaS / dashboard.

| Deliverable style | Base branch |
| --- | --- |
| Text / strategy / long-form (Markdown) | `feature/9be0a6a2-5567-41bf-ad06-cb4014f0faf2/424cc56d-510e-4bbf-a4e1-aa2e30700325` |
| Media / design (galleries, icons, video links) | `feature/9be0a6a2-5567-41bf-ad06-cb4014f0faf2/512ceb6a-f133-4716-9a10-0d2a008c10ed` |
| Commercial decks / pitch / slides | `feature/ce1b2fec-3455-49a1-a35d-54671c00d00d` |
| PDF documents (interactive viewer) | `feature/16ccdd2c-6636-4b38-a4fc-89ea2c9fe0cc` |
| Data / analytics (heavy tables, CSV/JSON) | `feature/6e819746-5da2-4e3a-8192-0a592dff99cc` |
| Automation runner / webhook tester UI | `feature/c3dcbbab-585a-46e9-b320-19b149a24aa0` |

### B — Generic application (custom SaaS, dashboards, clones, platforms)

Pick Generic when the requirement is full product development, not a packaged Vitrina shell.

- Prefer an **existing app baseline**: check out `main`, or a team baseline such as `core-infrastructure`, or a branch named in `requirement.instructions`.
- Do NOT create a second Next.js project under a nested folder. The platform expects ONE repo root at `/vercel/sandbox` with `package.json` at the root and routes under `src/app/`.
- Do NOT run `npx create-next-app` unless `instructions` explicitly require a greenfield AND the repo is empty. The default is to extend the checked-out baseline.

## Required actions

1. Read `requirement.instructions` and the requirement type. Map to A (Vitrina) or B (Generic) with a one-line rationale. If the requirement has a Base Hint in section 8, respect it unless you find concrete evidence it is wrong.
2. Run Git in `/vercel/sandbox`:
   - `git fetch origin`
   - **For A**: `git checkout -B feature/<requirement_short_id> origin/<vitrina_branch>` (use the established naming convention for feature branches in this repo).
   - **For B**: `git checkout <baseline>` (e.g. `main` / `core-infrastructure`), then create / switch to the feature branch for this requirement.
3. Confirm the tree: `sandbox_list_files .` — expect `package.json` at the root and `src/app/` layout consistent with the choice.
4. **Persist the decision** via `requirements action="update"` — append a bullet to `instructions`:
   - `BASE: Vitrina <name> → branch <branch>` (for A), or
   - `BASE: Generic app → branch <branch>` (for B).
5. Optionally `requirement_status action="create"` with a short message summarizing the base selection for humans.
6. Follow platform checkpoint rules: if you changed files that must survive, call `sandbox_push_checkpoint`. If you only ran a checkout, the normal per-step checkpoint is enough.

## Handoff

- Vitrina content work follows **`makinari-obj-vitrinas`**.
- Generic app work follows **`makinari-rol-frontend`** / **`makinari-rol-backend`** directly.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_run_command` | `git fetch`, `git checkout`, `git status`, `git log --oneline -5`. |
| `sandbox_list_files` | Confirm root structure after checkout. |
| `sandbox_read_file` | Inspect `package.json` / `README` to confirm the baseline. |
| `requirements` | `action="update"` to append the `BASE: ...` bullet to `instructions`. |
| `requirement_status` | Optional: human-readable summary of the base selection. |
| `instance_plan` | `action="execute_step"` when the selection is done. |
| `sandbox_push_checkpoint` | Snapshot the workspace only if files were modified. |

## Artifacts

- **Produces**: `BASE: ...` bullet appended to `requirement.instructions`, working tree aligned to the chosen branch.
- **Consumes**: `requirement.instructions` section 8 (Base Hint) and overall type. No repo mutations beyond `git checkout`.

## Anti-patterns

- Skipping this step and building on the default branch by accident.
- Mixing Vitrina templates with generic SaaS in the same requirement without an explicit client decision.
- Creating `app/` or `apps/` at repo root. Routes live in `src/app/` only.
- Forgetting to append `BASE: ...` — downstream steps lose the decision trail.
