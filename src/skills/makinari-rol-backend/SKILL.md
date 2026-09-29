---
name: makinari-rol-backend
description: Backend development role for automations, API endpoints, and webhooks inside the Vercel Sandbox. Enforces dual-mode endpoints (test/prod), input validation, idempotency, structured logging, and the anti-mock rule.
types: ['develop', 'automation', 'integration']
---

# SKILL: makinari-rol-backend

## Objective

Implement API endpoints, webhooks, and automations that satisfy the requirement's section 6.1 (API contracts) and 6.2 (DB changes) exactly. Every backend deliverable must boot, run, and return real data under `?mode=prod` and mock-free success under `?mode=test` — no invented payloads, no silent catches.

## Environment

- **Working directory**: `/vercel/sandbox` (the repo is already cloned).
- **Routing**: API routes live under `src/app/api/**` (App Router). Do NOT create a top-level `app/`. Path confusion is a common model mistake and breaks Vercel.
- **Runtime**: Node.js (Next.js default) unless the requirement mandates `edge`.
- **File size limit**: per project rules, keep each file under 500 lines. If a handler grows, split helpers into sibling files.

## Execution Rules

### 1. Honor the requirement contract
Read `requirement.instructions` sections 6.1 (API), 6.2 (DB), 6.3 (Env) and implement verbatim. If the contract is missing a detail you need (e.g., a missing field, an unspecified helper endpoint):
- **Apply Contract Adequation:** Do NOT pause or block execution. Proactively invent the missing field or endpoint using industry standards to complete the feature.
- **Report it:** You MUST explicitly document this addition in your `step_output` using the `[CONTRACT ADEQUATION]` flag so the Orchestrator can sync the master contract. See `makinari-contract-adequation` for full details.
- **Database boundary:** Contract adequation never permits inventing platform capabilities or authorization. The verified Supabase capability contract and migration rules in section 6 take precedence; report missing prerequisites instead.

### 2. Dual-mode support (`?mode=test` and `?mode=prod`) — mandatory
Every public endpoint MUST accept both modes.

| Mode | Auth | Side-effects | Response |
| --- | --- | --- | --- |
| `test` | No auth required | None. No DB writes, no external calls with side-effects. | Deterministic success shape, tagged `"mode": "test"`. |
| `prod` | Full auth (API key / token per project convention). | Real execution. | Real data, tagged `"mode": "prod"`. |

**Canonical response shape (align test and prod)**

```ts
// src/app/api/example/route.ts
import { NextRequest, NextResponse } from 'next/server';

type Ok<T> = { ok: true; mode: 'test' | 'prod'; data: T };
type Err = { ok: false; mode: 'test' | 'prod'; error: { code: string; message: string; details?: unknown } };

export async function POST(req: NextRequest) {
  const mode = new URL(req.url).searchParams.get('mode') === 'test' ? 'test' : 'prod';
  const body = await req.json().catch(() => ({}));

  const parsed = InputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<Err>({
      ok: false, mode,
      error: { code: 'invalid_input', message: 'Validation failed', details: parsed.error.flatten() },
    }, { status: 400 });
  }

  if (mode === 'test') {
    return NextResponse.json<Ok<{ echoed: typeof parsed.data }>>({
      ok: true, mode, data: { echoed: parsed.data },
    });
  }

  const auth = await requireAuth(req);
  if (!auth.ok) return NextResponse.json<Err>({ ok: false, mode, error: auth.error }, { status: 401 });

  const result = await runRealWork(parsed.data, auth.user);
  return NextResponse.json<Ok<typeof result>>({ ok: true, mode, data: result });
}
```

Keep the response shape identical across modes; only the `data` differs. This lets the QA gate diff shapes deterministically.

### 3. Input validation — mandatory
Validate every incoming payload with a schema (prefer **Zod**; if Zod is not available in the branch, use a hand-written guard that mirrors the schema).

```ts
import { z } from 'zod';

const InputSchema = z.object({
  email: z.string().email(),
  amount: z.number().int().positive(),
  metadata: z.record(z.string()).optional(),
});
type Input = z.infer<typeof InputSchema>;
```

Never trust `req.json()` without parsing. Reject malformed input with `400` and a structured `error.details` payload (see section 2).

### 4. The Boy Scout Rule (Refactor before you feature)
When you open an existing file to add a new feature, you MUST evaluate its current health before adding your code:
1. If the file is over 500 lines, you MUST extract parts of it into smaller components/modules BEFORE adding your new logic.
2. If the file contains mock data or fake authentication, you MUST replace it with real integrations if possible.
3. If the code is messy or lacks ES Modules structure, clean it up.
Always leave the code cleaner than you found it. Do this refactoring as part of your current step. Do NOT leave technical debt assuming a maintenance agent will clean it up later. You are responsible for the quality of the code you write.
Applied SQL migrations are excluded from refactoring; preserve them exactly and use the forward-repair rules in section 6.

### 5. Idempotency (webhooks, cron, retries)
Any endpoint that mutates state MUST be safe to call twice with the same payload.

- Accept an idempotency key from the caller (`Idempotency-Key` header) OR derive one deterministically from the payload (`hash(body + timestamp bucket)`).
- Persist the key before side-effects; short-circuit on replay with the stored response.
- For cron consumers, combine the requirement id + step id to form the key so the same step never commits twice.

```ts
const key = req.headers.get('idempotency-key') ?? deriveKey(parsed.data);
const replay = await loadReplay(key);
if (replay) return NextResponse.json(replay.body, { status: replay.status });
const result = await doWork(parsed.data);
await saveReplay(key, { body: { ok: true, mode, data: result }, status: 200 });
return NextResponse.json({ ok: true, mode, data: result });
```

### 5. Observability (structured logging)
- For **application endpoints**: emit structured logs with a stable `event` string and relevant ids. Use `console.error` for failures (Vercel captures) and `console.info` for business events. Never swallow errors silently in `try/catch`.
- For **cron / infrastructure steps** that run inside `src/app/api/cron/**`, write events to the Supabase infrastructure log via [src/lib/services/cron-audit-log.ts](../../lib/services/cron-audit-log.ts) (`CronInfraEvent.*`). Do NOT invent new event names without adding them to the enum first.
- Every error response MUST include `error.code` (stable, snake_case) and `error.message` (human). Do not leak stack traces in `prod` mode.

### 6. DB changes and Supabase Schemas (CRITICAL ARCHITECTURE RULE)

Read [makinari-obj-apps-supabase](../makinari-obj-apps-supabase/SKILL.md) first.
That skill is the canonical contract for database, identity, backend operations,
and storage; this role must not weaken it to satisfy an endpoint requirement.

**Verified capabilities and identity (before writing SQL or SDK code)**
- Consume the verified version 1 manifest passed in the system context or returned
  by `sandbox_db_capabilities`. Use the exact `requirement_id`, `tenant_id`, `schema`,
  and qualified identity helper names from that manifest. Do not invent IDs,
  schemas, helper names, buckets, or RPCs, or derive a schema from an ID.
- If the manifest is missing, inconsistent, or unverified, stop the dependent work
  and report the specific provisioning gap. An app file or env dump is not a
  capability source. Do not inspect env secrets or decode tokens to discover capabilities.
- The provisioner installs `_app_current_user_id()`, `_app_request_claims()`, and
  `_app_is_backend_request()` in each tenant schema before the agent runs. These
  helpers are platform-owned and immutable. Do not create, replace, alter, rename,
  drop, or shadow them, change their permissions, or set request claims. Report
  missing helpers as provisioning failures; do not request auth/admin grants.
- `_app_current_user_id()` supplies identity, not tenant or organization membership.
  `_app_request_claims()` is not a blanket authorization grant. Never authorize
  from `user_metadata` or other user-editable claims. Use protected tenant-local
  membership/roles when the product requires organization access.
- Ordinary migrations and policies may call the verified helpers unqualified
  because the runner sets the tenant search path. In persisted function
  definitions, fully qualify every helper call and tenant table reference with
  the exact schema from the verified manifest. Never persist a placeholder schema
  or call global auth functions in place of the local identity helpers.

**Static, tenant-only migration contract**
- Write plain `.sql` files in `migrations/*.sql`, not ORM migration classes.
  Use static, tenant-only SQL with unqualified table names. The migration runner
  owns `search_path`. Do not set or override it, including local/session settings
  or configuration-function calls. Qualification, when required, must use only
  the exact verified tenant schema, never a copied example or another tenant.
- `DO` blocks and dynamic SQL (`EXECUTE`) are forbidden, including idempotent
  wrappers. Never enumerate or loop over schemas or propagate changes to all
  tenants. Inspect only this tenant with `sandbox_db_inspect` and write ordinary
  static DDL for its inspected tables. Do not read/write global or other tenants'
  schemas, including `public`, `auth`, and `storage`.
- `GRANT` / `REVOKE` and schema, role, or extension administration are forbidden.
  Do not disable RLS or use `SECURITY DEFINER` routines. Tenant views must use
  `WITH (security_invoker = true)`; they are not an authorization bypass.
- `src/lib/services/apps-platform/migration-linter.ts` is the enforcement contract.
  Fix rejected SQL; never weaken the linter or bypass `sandbox_db_migrate` with
  custom scripts, raw HTTP, or privileged platform SQL RPCs.
- If the requirement declares new columns in section 6.2, create the migration
  before implementing the endpoint that reads them. Prefer supported static
  idempotent DDL such as `ADD COLUMN IF NOT EXISTS` after inspecting the schema;
  it does not justify wrappers or hide mismatched existing definitions.
- Every new table must enable RLS and declare an explicit policy in the same SQL
  file, including tables created with `IF NOT EXISTS`. Use row ownership,
  correlated membership, or explicit denial, not unconditional predicates or
  standalone logged-in checks. `TO authenticated` alone is not tenant isolation.
  This complete user-owned CRUD example applies only when the product contract
  calls for private reservations, not shared organization records:

  ```sql
  -- Recovery: use a new forward migration after reviewing dependent code/data.
  CREATE TABLE reservations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
  );
  ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

  CREATE POLICY reservations_select ON reservations
    FOR SELECT TO authenticated USING (_app_current_user_id() = user_id);
  CREATE POLICY reservations_insert ON reservations
    FOR INSERT TO authenticated WITH CHECK (_app_current_user_id() = user_id);
  CREATE POLICY reservations_update ON reservations
    FOR UPDATE TO authenticated USING (_app_current_user_id() = user_id)
    WITH CHECK (_app_current_user_id() = user_id);
  CREATE POLICY reservations_delete ON reservations
    FOR DELETE TO authenticated USING (_app_current_user_id() = user_id);
  ```

For a later change, first verify `reservations`, its columns, RLS, and policies
with `sandbox_db_inspect`. This static migration changes only that existing tenant
table and preserves its authorization; a missing table is a prerequisite to fix,
not a reason to scan every schema:

```sql
-- Recovery: review stored notes and dependent queries before a forward repair.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS notes text;
CREATE INDEX IF NOT EXISTS reservations_user_starts_at_idx
  ON reservations (user_id, starts_at);
```

**SDK schema binding**
Reuse the canonical skill's clients. `NEXT_PUBLIC_APPS_TENANT_SCHEMA` must match
the verified manifest's `schema`. No fallback to `public`, generic Supabase envs,
or another tenant, even after a schema-cache error. Always explicitly call
`.schema()` before `.from()` or tenant `.rpc()`; global client options alone are
not the binding contract. After verifying the manifest/configuration match:

```ts
const SCHEMA_NAME = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA?.trim();
if (!SCHEMA_NAME || SCHEMA_NAME === 'public') {
  throw new Error('Missing verified Apps Supabase tenant schema');
}
const { data, error } = await supabase.schema(SCHEMA_NAME).from('reservations').select('*');
if (error) throw error;
```

**Applied migrations, pending repairs, and test data**
- Applied migrations are immutable. Preserve their original path and exact
  contents, including comments and whitespace. Never edit, rename, delete, or
  rewrite applied SQL, even during refactoring. Restore any changed applied file
  from version control, then add a new uniquely named, ordered forward migration
  for the repair. Describe recovery in comments when authoring new files; do not
  add comments to an already-applied file or bypass checksum mismatches.
- Pending, never-applied migrations may be edited, including linter-rejected files.
  Confirm application status from migration receipts first: earlier files in a
  failed batch may already be applied. The runner stops at the first failing file;
  repair that pending file before retrying, because merely appending a later
  migration cannot unblock it. Do not modify ledger rows or invoke privileged SQL RPCs.
- Apply through `sandbox_db_migrate`, inspect through `sandbox_db_inspect`, and
  record the migration receipt and verification evidence in `step_output`.
- Never insert dummy/test data into production or production migrations. Test
  fixtures belong only in isolated test environments with explicit authorization
  and cleanup. `?mode=test` remains side-effect-free and must not write DB rows.
  Use authorized real data or approved isolated fixtures for RLS probes; do not
  manufacture production records just to populate the frontend.

### 6.1 RLS policy templates by table intent (mandatory for new or updated policies)
These templates are alternatives for existing tenant tables. Inspect schema,
constraints, and all policy names first; adapt only to the product authorization
contract. Remove obsolete permissive policies explicitly in the same migration:
permissive policies combine with OR, so adding a scoped policy cannot repair
another open policy. Do not add a search-path preamble.

**Forward policy replacement on an existing private table**
```sql
-- Recovery: correct the predicate in a new forward migration, not applied SQL.
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reservations_select ON reservations;
CREATE POLICY reservations_select ON reservations
  FOR SELECT TO authenticated
  USING (_app_current_user_id() = user_id);
```

Organization examples assume inspected `studios` / `projects` tables with
`organization_id` and a protected `organization_memberships` table with
`organization_id`, `user_id`, and `role`. Use `editor` / `admin` only if those
values and permissions are confirmed by the product contract. Do not invent a
membership model or a role helper to make the examples apply. Do not silently
change a shared organization model to creator-only ownership to make lint pass;
preserve authorized team access or report the missing prerequisite.

**Protected membership control table (self-read, no direct writes)**
```sql
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_memberships_self_read ON organization_memberships;
CREATE POLICY organization_memberships_self_read ON organization_memberships
  FOR SELECT TO authenticated
  USING (user_id = _app_current_user_id());
```
Require no direct user writes to membership, role, or permissions. Remove any
obsolete write/open policies found by inspection; self-read neither enrolls users
nor grants role updates. Changes need an explicitly authorized backend operation.

**A) Reference/catalog table (member reads; no implicit admin writes)**
```sql
ALTER TABLE studios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS studios_member_read ON studios;
CREATE POLICY studios_member_read ON studios
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE m.organization_id = studios.organization_id
        AND m.user_id = _app_current_user_id()
    )
  );
```

**B) Private user-owned table (strict ownership)**
Use the complete CRUD predicates in section 6. For existing policies, precede
each replacement with `DROP POLICY IF EXISTS` as above and remove any obsolete
policies discovered by inspection. Ownership must not grant edits to privileges.

**C) Team/org-scoped table (member reads; protected editor/admin writes)**
```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_member_access ON projects;
DROP POLICY IF EXISTS projects_member_read ON projects;
CREATE POLICY projects_member_read ON projects
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = _app_current_user_id()
    )
  );

DROP POLICY IF EXISTS projects_editor_access ON projects;
CREATE POLICY projects_editor_access ON projects
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = _app_current_user_id()
        AND m.role IN ('editor', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = _app_current_user_id()
        AND m.role IN ('editor', 'admin')
    )
  );
```

**D) System/internal table (no direct anon/user access)**
```sql
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_events_no_direct_access ON webhook_events;
CREATE POLICY webhook_events_no_direct_access ON webhook_events
  FOR ALL
  USING (false)
  WITH CHECK (false);
```
This denies access only when no other policy permits it. A server-side JWT does
not automatically override a deny predicate. Backend access requires a separately
authorized operation and its own scoped RLS, not a service-role assumption.

**Control-table safeguard (`users`, `roles`, permissions tables)**
- Never query a control table from its own policy; moving a recursive lookup into
  `WITH CHECK` does not solve recursion or privilege escalation.
- Use `id = _app_current_user_id()` for self-read of an inspected profile table.
  Ownership alone does not authorize updates to roles, permissions, or memberships.
  Keep privilege-bearing fields on a trusted server-controlled path; do not grant
  self-update access to them or enroll users into organizations on login.

**Backend identity and public endpoints are not authorization shortcuts**
- The manifest's `backend.role` is `authenticated` and `backend.bypasses_rls` is
  `false`; `APPS_TENANT_JWT` is not a service-role key or an end-user session.
  `backend.operations: []` means no app-specific backend operations are registered.
  Do not invent an existing RPC. `_app_is_backend_request()` verifies the trusted
  top-level claims against the provisioned tenant registry binding; it is not an
  RLS bypass, membership grant, or authorized data operation.
- Obtain an explicit product authorization contract (actor, tenant, operation,
  fields, limits) and inspect the actual tables, policies, and routines. Only then
  implement an authorized app-specific transaction with validated inputs,
  server-fixed tenant/destination, bounded effects, and operation-specific RLS
  using the provisioned backend helper. If a routine is needed, use a static
  `SECURITY INVOKER` definition with fully qualified tenant tables/helper calls.
  Report missing capabilities or authorization instead of weakening policies.
- Public intake and catalog reads are not exceptions. Use a narrow, explicitly
  authorized server-controlled path with abuse controls and safe response fields;
  a route handler alone is not authorization. Cookie clients still obey user RLS.
  Do not create accounts or memberships for unverified public intake. Follow the
  canonical skill's verified onboarding flow and report unavailable capabilities.

**Post-migration verification checklist (required)**
1. Verify policy names and table schema through `sandbox_db_inspect`.
2. Probe anon, authenticated non-member, member, editor/admin, and wrong-tenant
   requests as applicable using supported test sessions/tools, never forged claims.
3. For system/internal tables, verify user requests are denied and only explicitly
   authorized backend operations succeed. Login alone must not confer membership.
4. Record migration receipts, exact table/policy names, and allowed/denied probe
   outcomes in `step_output`. Lint success is not proof of runtime SQL behavior
   or business authorization.

### 7. Environment variables
- Declare every new env var in section 6.3 of the requirement first. If you need a var that is not declared, stop and update the requirement.
- Read vars from `process.env` at the top of the module. Never hardcode.
- For client-side access use the `NEXT_PUBLIC_` prefix. Otherwise keep the var server-only.

### 8. Shift-left testing (before reporting completion)
1. `sandbox_run_command` with `npm run build` (or `tsc --noEmit` if faster for your change). Fix every TypeScript, lint, and import error.
2. If running jest tests, always use `sandbox_run_command npm test -- --passWithNoTests --runInBand --testTimeout=10000` to prevent sandbox hanging ("Stream ended before command finished").
3. `sandbox_run_command` with curl against `?mode=test`:
   ```
   curl -s "http://localhost:3000/api/<path>?mode=test" -H "Content-Type: application/json" -d '{...}'
   ```
   Verify the canonical shape: `{ ok: true, mode: "test", data: ... }`.
4. If the endpoint mutates DB, also verify no row was created in test mode.
5. Only then mark the step completed.

### 9. Anti-mock policy (project rule)
- **Never** return hardcoded fake payloads in `?mode=prod`. Test mode is the only place where static data is acceptable.
- **Never** wrap `try/catch` to "make tests pass"; fix the root cause.
- No placeholder endpoints that return `{ ok: true }` without doing the declared work.

### 10. Delivery
- The system auto-commits and pushes. You do NOT run `git` mutations manually.
- Report progress with `instance_plan action="execute_step"`:
  - `step_status="completed"` only after section 8 passes.
  - `step_output`: short summary (endpoint path, modes verified, migrations applied).

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_db_capabilities` | Obtain the verified tenant manifest; report missing capabilities rather than guessing. |
| `sandbox_db_migrate` | Apply pending static tenant migrations and record receipts; never rewrite applied files. |
| `sandbox_db_inspect` | Inspect this tenant's tables, policies, and supported data probes before and after migration. |
| `sandbox_run_command` | Run `npm run build`, `tsc --noEmit`, curl smoke tests, read-only git commands. |
| `sandbox_write_file` | Create or update TypeScript files under `src/app/api/**`; create forward SQL files or edit confirmed never-applied files under `migrations/`. |
| `sandbox_read_file` | Read existing routes, services, and `src/lib/**` helpers before editing. |
| `sandbox_list_files` | Explore the route tree to avoid duplicating endpoints. |
| `requirements` | Read contract (section 6). Update `## Open Questions` if the contract is incomplete. |
| `instance_plan` | Report `execute_step` status; split into sub-steps when a handler requires DB migrations. |

Prefer `sandbox_run_command npm run build` over piecemeal `tsc` when in doubt; Next.js App Router surfaces route-level errors only during a full build.

## Artifacts

- **Produces**: API route files under `src/app/api/**`, SQL migrations under `migrations/*.sql`, test curl transcripts captured in `step_output`.
- **Consumes**: `requirement.instructions` sections 6.1, 6.2, 6.3, 7 (Acceptance Criteria). Verifies section 7 in step 8.

## Anti-patterns

- Diverging response shapes between `test` and `prod` modes.
- Skipping Zod/manual validation because "the frontend already validates".
- Catching all errors and returning `200` with `{ ok: false }`. Return the real status code (`400`, `401`, `409`, `500`) so QA probes detect regressions.
- Hardcoding secrets or database URLs. Always go through `process.env`.
- Editing `cron-audit-log.ts` to add ad-hoc events. Extend the `CronInfraEvent` enum in a dedicated pass with the orchestrator's review.
