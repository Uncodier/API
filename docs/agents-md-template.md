# `AGENTS.md` canonical template per flow

The harness writes (or refreshes) an `AGENTS.md` file at the root of every
generated repo the first time a requirement branch is checked out. The file
is the ground-truth cheat sheet for all sub-agents and is regenerated
idempotently by `src/skills/makinari-agents-md/SKILL.md`.

The contents depend on the flow (see `src/lib/services/requirement-flows.ts`).
Copy-paste the right block when seeding a repo manually.

---

## app / site

```markdown
# AGENTS.md

## Flow
- kind: **app**
- phases: base → investigate → build → qa → validate → report
- gate: build + runtime (1280×800 + 375×812) + visual critic + E2E + Vercel deploy
- standard library: **ShadCN** + Tailwind + Radix + lucide-react

## Capabilities available (Uncodie Platform SDK, test-only)
- `uncodie.email.send` (recipients must be leads of this `site_id` or `is_test=true`)
- `uncodie.whatsapp.send` (same allowlist)
- `uncodie.leads.read|write`
- `uncodie.notifications.create`
- `uncodie.tracking.event.write`
- `uncodie.agents.invoke('<tool>')`

## Apps DB (tenant Supabase)
- `src/lib/supabase.ts` (client + server components, anon key, `db.schema = NEXT_PUBLIC_APPS_TENANT_SCHEMA`)
- `src/lib/supabase-server.ts` (route handlers, tenant JWT — `APPS_TENANT_JWT`)
- Migrations via `/api/platform/db/migrations` (scope `db.migrate`). Never hit Supabase directly with a service key.
- Baseline migration creates an empty tenant schema with RLS on. Every `CREATE TABLE` must enable RLS and use `auth.uid()` or local roles.

## Backlog rules
- WIP=1 (enforced by `requirement_backlog`). Only ONE `in_progress` item at a time.
- Each plan step MUST set `metadata.backlog_item_id`.
- Done items are sealed. To fix a done item, call `requirement_backlog action='set_status'` with `status='pending'` + a reason.

## Evidence contract
- Every passing step writes `evidence/<item_id>.json` (build + tests + runtime + scenarios + judge verdict).
- The Judge rejects claims not backed by tool-call evidence.
```

---

## doc / contract

```markdown
# AGENTS.md

## Flow
- kind: **doc** (or **contract**)
- gate: markdown lint + broken-link check + front-matter + heading hierarchy
  (contract adds placeholder + signature/date checks)
- standard library: **MDX + remark**

## Structure
- `src/content/**/*.mdx` (doc) or `contract/clauses/*.mdx` + `contract/schedule.mdx`
- Every file needs front-matter `title`, `updated_at`, `owner`.
- No raw HTML inside MDX; use components under `src/components/content/` if interactivity is needed.

## Backlog + evidence
- Same rules as the app flow. Items have `kind='section'|'chapter'|'clause'|…`.
- `evidence/<id>.json` records lint exit code, front-matter validation, links 2xx list, and placeholder resolution count.
```

---

## presentation

```markdown
# AGENTS.md

## Flow
- kind: **presentation**
- gate: deck build + slide count ≥ 3 + per-slide word budget ≤ 120
- standard library: **reveal.js** (or spectacle — choose once per requirement, document in `requirement.spec.md`)

## Structure
- `presentation.md` with `---` slide separators, OR `slides/*.mdx`.
- Assets under `assets/` (PNG/SVG).

## Backlog + evidence
- Items have `kind='slide'|'chart'|'asset'`.
- Each slide lists its goal + talk track in `acceptance[]`; Judge verifies the word budget + presence of at least one asset when the slide is a chart/visual.
```

---

## automation / task / makinari

```markdown
# AGENTS.md

## Flow
- kind: **automation** (or **task** / **makinari**)
- gate: entrypoint detection (`route.ts` / `server.ts` / `run.sh`) + syntax check
- no UI kit; produce artefacts under `artifacts/`, `reports/`, `outputs/`

## Structure
- `run.sh` (executable) describing the happy path invocation.
- `README.md` explaining inputs/outputs and how to re-run.
- Persist results as JSON/CSV under `artifacts/` so Judge can verify shape.

## Backlog + evidence
- Items have `kind='subtask'|'script'|'api'|'integration'`.
- `evidence/<id>.json` includes the command executed, exit code, and a tail of stdout.
```

---

## When `AGENTS.md` is created

1. **Bootstrap**: `makinari-agents-md` runs once per requirement branch on
   first checkout.
2. **Refresh**: The skill is re-invoked whenever the flow kind changes
   (unlikely) or a new capability is added to the Uncodie Platform SDK
   (append to the capability list; do not rewrite the file).
3. **Hand-edited?**: treat as a hint — the skill merges its canonical blocks
   on top, preserving any `## Notes` sections the agents wrote.
