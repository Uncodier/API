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

- Prefer an **existing app baseline**: check out `main`, or a team baseline such as `core-infrastructure`.
- **For complex apps with Auth/DB**: If the requirement needs login, users, or database, check out the `core-infrastructure-supabase` branch (based on the official Vercel Next.js + Supabase starter) instead of `main`. The branch already exists in the repo.
- Do NOT create a second Next.js project under a nested folder. The platform expects ONE repo root at `/vercel/sandbox` with `package.json` at the root and routes under `src/app/`.
- Do NOT run `npx create-next-app` unless `instructions` explicitly require a greenfield AND the repo is empty. The default is to extend the checked-out baseline.

## Required actions

1. Read `requirement.instructions` and the requirement type. Map to A (Vitrina) or B (Generic) with a one-line rationale. If the requirement has a Base Hint in section 8, respect it unless you find concrete evidence it is wrong.
2. Run Git in `/vercel/sandbox`:
   - `git fetch origin`
   - **For A**: `git checkout -B feature/<requirement_short_id> origin/<vitrina_branch>` (use the established naming convention for feature branches in this repo).
   - **For B**: `git checkout <baseline>` (e.g. `main` / `core-infrastructure` / `core-infrastructure-supabase`), then create / switch to the feature branch for this requirement (`git checkout -b feature/<requirement_short_id>`).
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

## Standard library per requirement kind (Phase 6)

| Kind                | Standard library                                                                 | Bootstrap when missing |
| ------------------- | -------------------------------------------------------------------------------- | ---------------------- |
| `app` / `site`      | ShadCN + Tailwind + Radix + lucide-react (`@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`) | `npx shadcn init` (use existing `components.json` if present); copy `@/components/ui/{button,input,select,dialog,form,table}` |
| `doc` / `contract`  | MDX + remark (`@mdx-js/loader`, `@mdx-js/mdx`, `remark-parse`, `unified`)        | Already present in this repo's deps for the docs site; for generated apps, install `@mdx-js/loader` + `remark-parse` |
| `presentation`      | reveal.js (or spectacle — pick one and document in `requirement.spec.md`)        | `npx --yes reveal-md@latest` smoke test; `npm i reveal.js` for a custom build |
| `automation` / `task` | No UI kit. Produce artefacts under `artifacts/` / `reports/` / `outputs/` and a `run.sh` entrypoint | `mkdir -p artifacts && touch run.sh && chmod +x run.sh` |

The matching gate (in `src/app/api/cron/shared/gates/`) probes the required
deliverables for each kind. Skip the standard library and the gate fails
immediately — there is no "raw HTML" fallback for apps.

## Uncodie Platform default (capability gateway)

Before provisioning any third-party service (Stripe, Resend, Twilio, Auth0,
ajeno Supabase, etc.), check whether the capability is already covered by the
Uncodie Platform SDK. The SDK lives under `src/lib/uncodie/` in the generated
app and consumes `/api/platform/*` from the main Uncodie API using a
test-only bearer key baked into `UNCODIE_API_KEY` + `UNCODIE_API_BASE`.

Currently exposed: `email.send` (test-only), `leads.read|write`,
`notifications.create`, `tracking.event.write`, `agents.invoke` and
`db.migrate`. The SDK template lives at
`src/templates/uncodie-sdk/*.ts` in the Uncodie API repo — copy that tree
into `src/lib/uncodie/` inside the generated app when the base branch does
not already ship it.

If a capability is genuinely missing, do NOT work around it with a raw
third-party SDK; instead add a backlog item `kind='integration'` via
`requirement_backlog action='upsert'` so the Producer can extend the
platform properly.

## Apps Supabase helpers (DB + Auth per tenant)

When the requirement ships an app/site that stores data or authenticates
users, copy the two Supabase helpers into the generated app:

```ts
// src/lib/supabase.ts (browser + server components)
export const db = createClient(
  process.env.NEXT_PUBLIC_APPS_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_APPS_SUPABASE_ANON_KEY!,
  { db: { schema: process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA! } }
);

// src/lib/supabase-server.ts (route handlers, uses tenant JWT)
export const dbServer = createClient(
  process.env.NEXT_PUBLIC_APPS_SUPABASE_URL!,
  process.env.APPS_TENANT_JWT!,
  { db: { schema: process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA! } }
);
```

The sandbox injects `APPS_SUPABASE_*` / `NEXT_PUBLIC_APPS_*` envs at runtime.
Apply schema changes only through `/api/platform/db/migrations` (scope
`db.migrate`) — never hit Supabase directly with the service key from inside
the generated app.

## Anti-patterns

- Skipping this step and building on the default branch by accident.
- Mixing Vitrina templates with generic SaaS in the same requirement without an explicit client decision.
- Creating `app/` or `apps/` at repo root. Routes live in `src/app/` only.
- Forgetting to append `BASE: ...` — downstream steps lose the decision trail.
- Installing `resend`, `twilio`, `stripe`, `@supabase/supabase-js` (with
  foreign URL), or `auth0` packages. The Uncodie Platform SDK + Apps Supabase
  cover the happy path; third parties require Producer approval.
