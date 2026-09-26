# Apps tenant provisioning regression (2026-09-26)

## Confirmed cause

The API provisions application tenants in the **Apps** Supabase project (currently
`faxxouxekfwxvexoitxv`), via `getAppsAdminClient()` in
`src/lib/database/apps-supabase.ts`. Do not point this client at the main
Makinari project to make an RPC appear to work: the 177 existing application
tenants and their schemas are in Apps, not in the main project.

On September 23 (commit `35ab4b2`) the API started requiring the atomic `apps_ensure_tenant`,
`apps_get_migration_receipt`, and `apps_apply_migration` RPCs. Their SQL was
added to this repo under `supabase/migrations/20260923194000_...` and
`20260923194100_...`. At the start of this diagnosis those RPCs were present
in **Makinari** (`rnjgeloamtszdjplmqxy`) but absent from **Apps**. The Apps
registry already existed and contained 177 tenants (most recently created
September 18), so a registry-only health probe reported `up` despite the
missing RPCs. For the NEX CARGO requirement
`5a1d6caa-92a4-420d-80f2-567392a1af11`, there was no Apps tenant;
`sandbox_db_migrate` returned `Tenant not provisioned for this requirement`
and `applied: []`.

The preflight previously logged the provisioning exception and continued
without tenant env variables. It now stops the cycle as an infrastructure
failure instead of allowing the agent to spend product attempts; it also
checks the sandbox env write's exit code. Apps health
checks the read-only receipt RPC; schema exposure uses the same project URL
as `getAppsAdminClient()` when Apps and Repository URLs differ.

**Concurrent change observed:** During this investigation, the three RPCs
appeared in Apps, and sampled existing `_meta` tables were re-owned by
`apps_migration_coordinator` with tenant executors installed. Someone or some
other deployment appears to have rolled out the migration concurrently; this
investigation did not deploy it. A read-only check confirmed `service_role`
can execute the three RPCs and `anon`/`authenticated` cannot. A direct SQL
call to the receipt RPC from this inspection connection was denied (the
connection is not `service_role`), so end-to-end service-role/PostgREST
operation is **not yet proven**. At last check NEX CARGO still had no tenant.

## Recovery / validation

1. Confirm the deployed API's `APPS_SUPABASE_URL` (or, if unset,
   `REPOSITORY_SUPABASE_URL`) and the matching service key/JWT secret point to
   the **same Apps project**. Verify the migration target is Apps, **not**
   Makinari. Never copy production keys into a generated application.
2. Before doing any further migration rollout, **recheck Apps**: the three
   RPCs were installed while this investigation was in progress. Do not
   reapply them merely because this document describes their earlier absence.
   If a staging environment or another Apps project still lacks them, review
   the three SQL files in this order:
   - `supabase/migrations/20260923193900_create_apps_platform_tables.sql`
   - `supabase/migrations/20260923194000_apply_tenant_migration_atomically.sql`
   - `supabase/migrations/20260923194100_ensure_tenant_atomically.sql`

   Do **not** push the API's entire `supabase/migrations/` directory to Apps:
   it contains main-project migrations. Do **not** recreate the existing 177
   tenant schemas. Migration `194000` walks existing schemas, changes object
   owners, hardens views/functions and introduces constrained tenant owner
   roles. Review impact on existing tenant workflows and schedule a backup,
   staging rehearsal, and maintenance window before applying it to Apps.
3. After the Apps rollout, confirm all three RPCs exist and grant execute only
   to `service_role`. Verify existing tenant schema ownership/permissions and
   run a read-only `apps_get_migration_receipt` probe for an existing tenant.
   Do not call `apps_ensure_tenant` or `apps_apply_migration` as a health probe;
   they write state.
4. Deploy the API fix, check `database_apps` is `up`, then allow a new cron
   cycle for NEX CARGO. Verify a tenant row and `app_<requirement>` schema
   appear **in Apps**, `sandbox_db_migrate` returns a genuine receipt, and
   `sandbox_db_inspect` can read the expected tables. Never infer that a
   migration was applied just from the agent's step output.

No database migrations were applied as part of this investigation.