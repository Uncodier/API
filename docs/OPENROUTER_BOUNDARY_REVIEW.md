# OpenRouter boundary review corrections

Local-only checkpoint, 2026-11-12. No deployment, remote SQL, production build or
paid provider calls were performed.

## Authorization and admission

- Supervisor authenticates a real JWT/API-key/service principal before reading
  the command authorization envelope. Current site access precedes command-content
  loading, processor initialization and private payer restoration. Explicit and
  context/result-derived conversations must belong to that same authorized site
  before inference or message writes. A caller's user/site metadata is not auth.
- Public image generation retains principal/site or scoped-signature admission,
  cache behavior and locking. New execution uses rollout-aware HTTP routing:
  pre-schema and rollback admissions stay global without connection-table reads;
  signed host references retain their original payer.
- Legacy instance-plan POST now validates an explicit creation schema, rejects
  client payer/site/user/metadata authority, authorizes the stored instance site
  and procurement resource permission, and attributes the real actor.
- Growth and legacy instance-act independently authenticate and check resource
  ownership before session reads, plan replacement, provisioning or inference.

## Current plan creator inventory

Source inventory searched API `src`, API SQL migrations and market-fit `app`,
`lib`, SQL migrations for instance-plan inserts/upserts. The current direct
TypeScript creators are:

1. `agents/tools/instance_plan/create/core.ts`
2. `agents/growth/robot/plan/route.ts`
3. `instances/[id]/plans/create.ts`
4. `robots/instance/act/save-plan.ts` (extracted from the oversized route)
5. `services/robot-instance/robot-plan-service.ts`
6. `services/robot-plan-execution/plan-manager.ts`
7. `services/workflow-robot/materialize.ts` template creation
8. `services/workflow-robot/materialize.ts` runnable workflow creation

All create blocked rows and write the private pin before runnable publication;
templates remain blocked. Replacement plans inherit the parent's immutable pin.
Global plans also pin when storage is ready; a failed pin leaves work blocked.
`getPlanRouting` continues to fail closed on a missing pin, not guess a payer.

The SQL creator is `patch_agent_requirement_plan`, originally introduced in
`20261014040000_agent_requirement_progress.sql`. New forward migration
`20261112071000_requirement_plan_private_routing.sql` preserves its original
generation/lease/backlog checks and pins within the same transaction. Its new
service-only overload accepts only the validated host tool closure's routing.
The model schema cannot supply that field. The old signature explicitly admits
new legacy/global work as platform-funded; updates preserve existing private
customer pins. Missing existing pins fail closed. No current direct client-side
plan insert was found in the web repository's app/lib source.

Deployment order: shared database migration `20261112022000` must precede API
`20261112071000`; deploy both before setting `OPENROUTER_ROUTING_STORAGE_READY`.
Keep storage ready during customer rollout rollback. Never edit the historical
function migration or backfill new plans by guessing today's connection.

## Verification

Focused Jest boundary tests live in
`src/lib/integrations/openrouter/__tests__/{supervisor-boundary,plan-creator-boundaries,growth-plan-boundary,legacy-plan-writers,act-plan-admission,requirement-plan-routing-sql}.test.ts`.
The SQL test executes both original and forward SQL on disposable local PGlite,
including ACL denial, cross-site/credential rejection, atomic rollback, customer
pin preservation, and legacy admission. It never uses configured database URLs.
Image, plan-lock, workflow, requirement-tool and existing routing regressions
exercise preserved behavior; final delivery records exact commands and counts.