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
- SQL scripts go under `src/scripts/*.sql`. Prefer `ALTER ... IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` so the script is idempotent.
- Document the rollback as a comment at the top of the script.
- If the requirement declares new columns in section 6.2, create the migration BEFORE implementing the endpoint that reads them.
- **CRITICAL: Supabase Schema Targeting (Multi-tenant Architecture)**: The database uses a schema-per-app architecture. Tables are NOT created in the default `public` schema. They are created in isolated schemas like `app_<id>`.
  - When querying Supabase via the JS/TS client, you **MUST** explicitly specify the schema using `.schema(process.env.SUPABASE_SCHEMA || 'app_<id>')` BEFORE calling `.from()`.
  - Example: `await supabase.schema(process.env.SUPABASE_SCHEMA).from('spaces').select('*')`
  - Failing to specify the schema will result in the error: `"Could not find the table 'public.table_name' in the schema cache"`. NEVER query without `.schema()` when working with app-specific tables.

### 7. Environment variables
- Declare every new env var in section 6.3 of the requirement first. If you need a var that is not declared, stop and update the requirement.
- Read vars from `process.env` at the top of the module. Never hardcode.
- For client-side access use the `NEXT_PUBLIC_` prefix. Otherwise keep the var server-only.

### 8. Shift-left testing (before reporting completion)
1. `sandbox_run_command` with `npm run build` (or `tsc --noEmit` if faster for your change). Fix every TypeScript, lint, and import error.
2. `sandbox_run_command` with curl against `?mode=test`:
   ```
   curl -s "http://localhost:3000/api/<path>?mode=test" -H "Content-Type: application/json" -d '{...}'
   ```
   Verify the canonical shape: `{ ok: true, mode: "test", data: ... }`.
3. If the endpoint mutates DB, also verify no row was created in test mode.
4. Only then mark the step completed.

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
| `sandbox_run_command` | Run `npm run build`, `tsc --noEmit`, curl smoke tests, read-only git commands. |
| `sandbox_write_file` | Create or update TypeScript files under `src/app/api/**` and SQL scripts under `src/scripts/`. |
| `sandbox_read_file` | Read existing routes, services, and `src/lib/**` helpers before editing. |
| `sandbox_list_files` | Explore the route tree to avoid duplicating endpoints. |
| `requirements` | Read contract (section 6). Update `## Open Questions` if the contract is incomplete. |
| `instance_plan` | Report `execute_step` status; split into sub-steps when a handler requires DB migrations. |

Prefer `sandbox_run_command npm run build` over piecemeal `tsc` when in doubt; Next.js App Router surfaces route-level errors only during a full build.

## Artifacts

- **Produces**: API route files under `src/app/api/**`, SQL migrations under `src/scripts/*.sql`, test curl transcripts captured in `step_output`.
- **Consumes**: `requirement.instructions` sections 6.1, 6.2, 6.3, 7 (Acceptance Criteria). Verifies section 7 in step 8.

## Anti-patterns

- Diverging response shapes between `test` and `prod` modes.
- Skipping Zod/manual validation because "the frontend already validates".
- Catching all errors and returning `200` with `{ ok: false }`. Return the real status code (`400`, `401`, `409`, `500`) so QA probes detect regressions.
- Hardcoding secrets or database URLs. Always go through `process.env`.
- Editing `cron-audit-log.ts` to add ad-hoc events. Extend the `CronInfraEvent` enum in a dedicated pass with the orchestrator's review.
