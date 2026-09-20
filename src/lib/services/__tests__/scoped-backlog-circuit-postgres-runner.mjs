import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const db = new PGlite();
const requirementId = '10000000-0000-4000-8000-000000000001';
const siteId = '20000000-0000-4000-8000-000000000002';
const instanceId = '30000000-0000-4000-8000-000000000003';
const planId = '40000000-0000-4000-8000-000000000004';
const replacementPlanId = '50000000-0000-4000-8000-000000000005';
const noPlanRequirementId = '60000000-0000-4000-8000-000000000006';
const stalePlanId = '70000000-0000-4000-8000-000000000007';

try {
  await db.exec(`
    CREATE TABLE public.requirements (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      site_id uuid NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      backlog jsonb NOT NULL DEFAULT '{}'::jsonb,
      backlog_revision integer NOT NULL DEFAULT 0,
      updated_at timestamptz
    );
    CREATE TABLE public.instance_plans (
      id uuid PRIMARY KEY,
      instance_id uuid NOT NULL,
      status text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      steps jsonb NOT NULL DEFAULT '[]'::jsonb,
      completion_reason text,
      completed_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz
    );
    CREATE TABLE public.requirement_cron_cycle_outcomes (
      requirement_id uuid NOT NULL,
      cycle_id text NOT NULL,
      cycle_started_at timestamptz NOT NULL,
      execution_generation integer NOT NULL,
      outcome text NOT NULL,
      runner_instance_id uuid,
      plan_id uuid,
      step_id text,
      PRIMARY KEY (requirement_id, cycle_id)
    );
  `);

  const accountingMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260919165000_scope_cron_no_progress.sql',
  ), 'utf8');
  await db.exec(accountingMigration.slice(
    0,
    accountingMigration.indexOf('\nREVOKE ALL ON FUNCTION'),
  ));
  const migration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260919192000_atomic_scoped_backlog_circuits.sql',
  ), 'utf8');
  await db.exec(migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION'),
    migration.indexOf('\nREVOKE ALL ON FUNCTION'),
  ));
  const compatibilityMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260919203000_restore_scoped_rpc_compatibility.sql',
  ), 'utf8');
  await db.exec(compatibilityMigration.slice(
    compatibilityMigration.indexOf('CREATE OR REPLACE FUNCTION'),
    compatibilityMigration.indexOf('\nREVOKE ALL ON FUNCTION'),
  ));
  const cycleIdentityMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260920002500_enforce_legacy_cron_cycle_identity.sql',
  ), 'utf8');
  await db.exec(cycleIdentityMigration.slice(
    cycleIdentityMigration.indexOf('CREATE OR REPLACE FUNCTION'),
    cycleIdentityMigration.indexOf('\nREVOKE ALL ON FUNCTION'),
  ));
  const cancellationMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260919235500_atomic_backlog_plan_step_cancellation.sql',
  ), 'utf8');
  await db.exec(cancellationMigration.slice(
    cancellationMigration.indexOf('CREATE OR REPLACE FUNCTION'),
    cancellationMigration.indexOf('\nREVOKE ALL ON FUNCTION'),
  ));

  await db.query(
    `INSERT INTO public.requirements
      (id, status, site_id, metadata, backlog, backlog_revision)
     VALUES ($1, 'in-progress', $2, $3::jsonb, $4::jsonb, 0)`,
    [
      requirementId,
      siteId,
      JSON.stringify({ requirement_execution_generation: 2 }),
      JSON.stringify({
        items: [
          { id: 'item-a', status: 'in_progress' },
          { id: 'item-b', status: 'pending' },
        ],
      }),
    ],
  );
  await db.query(
    `INSERT INTO public.instance_plans
      (id, instance_id, status, metadata, steps, created_at)
     VALUES (
       $1, $2, 'in_progress', $3::jsonb, $4::jsonb,
       '2026-09-19T19:00:00.000Z'
     )`,
    [
      planId,
      instanceId,
      JSON.stringify({ requirement_id: requirementId }),
      JSON.stringify([{
        id: 'step-1',
        status: 'in_progress',
        infrastructure_generation: 3,
        infrastructure_circuit_open: true,
        infrastructure_failure_provenance: 'cron_infrastructure',
        metadata: { backlog_item_id: 'item-b' },
      }]),
    ],
  );
  await db.query(
    `INSERT INTO public.instance_plans
      (id, instance_id, status, metadata, steps, created_at, updated_at)
     VALUES (
       $1, $2, 'failed', $3::jsonb, $4::jsonb,
       '2026-09-19T19:30:00.000Z', '2026-09-19T19:45:00.000Z'
     )`,
    [
      stalePlanId,
      instanceId,
      JSON.stringify({ requirement_id: requirementId }),
      JSON.stringify([{
        id: 'stale-failed-step',
        status: 'failed',
        metadata: { backlog_item_id: 'item-b' },
      }]),
    ],
  );

  const rpc = await db.query(
    `SELECT public.block_backlog_item_for_circuit_atomic(
      $1, $2, $3, $4, 'step-1', 'item-a', 3, 2,
      'infrastructure', 'blocker-1', 'infrastructure',
      'origin unavailable', 'system', NULL, 'cron_infrastructure',
      'cycle-1', 1, 4, 2
    ) AS result`,
    [requirementId, siteId, instanceId, planId],
  );
  const persisted = await db.query(
    'SELECT backlog_revision, backlog FROM public.requirements WHERE id = $1',
    [requirementId],
  );
  const overloads = await db.query(
    `SELECT proname, count(*)::integer AS count
     FROM pg_catalog.pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN (
         'record_requirement_cron_cycle_outcome',
         'block_requirement_for_product_no_progress'
       )
     GROUP BY proname`,
  );
  await db.query(
    `UPDATE public.instance_plans
        SET status = 'replaced',
            updated_at = '2026-09-19T20:01:00.000Z'
      WHERE id = $1`,
    [planId],
  );
  const cleanupOnlyLegacyScope = await db.query(
    `SELECT public.record_requirement_cron_cycle_outcome(
      $1, 'legacy-cleanup-only', '2026-09-19T20:00:00.000Z',
      'product_no_progress', 2, $2
    ) AS result`,
    [requirementId, instanceId],
  );
  await db.query(
    `INSERT INTO public.instance_plans
      (id, instance_id, status, metadata, steps, created_at)
     VALUES (
       $1, $2, 'in_progress', $3::jsonb, $4::jsonb,
       '2026-09-19T19:59:00.000Z'
     )`,
    [
      replacementPlanId,
      instanceId,
      JSON.stringify({ requirement_id: requirementId }),
      JSON.stringify([{
        id: 'replacement-step',
        status: 'in_progress',
        started_at: '2026-09-19T20:01:30.000Z',
        metadata: {
          backlog_item_id: 'item-b',
          cron_cycle_id: 'legacy-no-progress',
          cron_execution_generation: 2,
        },
      }, {
        id: 'retryable-step',
        status: 'failed',
        retry_count: 1,
        metadata: { backlog_item_id: 'item-a' },
      }]),
    ],
  );
  await db.query(
    `SELECT public.record_requirement_cron_cycle_outcome(
      $1, 'legacy-no-progress', '2026-09-19T20:00:00.000Z',
      'product_no_progress', 2, $2
    )`,
    [requirementId, instanceId],
  );
  const legacyNoProgress = await db.query(
    `SELECT plan_id, step_id
       FROM public.requirement_cron_cycle_outcomes
      WHERE requirement_id = $1 AND cycle_id = 'legacy-no-progress'`,
    [requirementId],
  );
  await db.query(
    `UPDATE public.instance_plans
        SET steps = jsonb_set(
          steps,
          '{0,metadata,cron_cycle_id}',
          '"legacy-progress"'::jsonb
        )
      WHERE id = $1`,
    [replacementPlanId],
  );
  await db.query(
    `SELECT public.record_requirement_cron_cycle_outcome(
      $1, 'legacy-progress', '2026-09-19T20:01:00.000Z',
      'progress', 2, $2
    )`,
    [requirementId, instanceId],
  );
  const legacyProgress = await db.query(
    `SELECT plan_id, step_id
       FROM public.requirement_cron_cycle_outcomes
      WHERE requirement_id = $1 AND cycle_id = 'legacy-progress'`,
    [requirementId],
  );
  await db.query(
    `UPDATE public.instance_plans
        SET steps = jsonb_set(
          jsonb_set(
            steps,
            '{0,metadata,cron_cycle_id}',
            '"later-unrecorded"'::jsonb
          ),
          '{0,started_at}',
          '"2026-09-19T20:03:00.000Z"'::jsonb
        )
      WHERE id = $1`,
    [replacementPlanId],
  );
  const overlappingLegacyScope = await db.query(
    `SELECT public.record_requirement_cron_cycle_outcome(
      $1, 'legacy-delayed', '2026-09-19T20:02:00.000Z',
      'product_no_progress', 2, $2
    ) AS result`,
    [requirementId, instanceId],
  );
  await db.query(
    `INSERT INTO public.requirements
      (id, status, site_id, metadata, backlog, backlog_revision)
     VALUES ($1, 'in-progress', $2, $3::jsonb, '{}'::jsonb, 0)`,
    [
      noPlanRequirementId,
      siteId,
      JSON.stringify({ requirement_execution_generation: 2 }),
    ],
  );
  const missingLegacyScope = await db.query(
    `SELECT public.record_requirement_cron_cycle_outcome(
      $1, 'no-plan-no-progress', '2026-09-19T20:01:00.000Z',
      'product_no_progress', 2, $2
    ) AS result`,
    [noPlanRequirementId, instanceId],
  );
  const atomicCancellation = await db.query(
    `SELECT public.cancel_requirement_plan_steps_for_backlog_items(
      $1, ARRAY['item-b'], 'item exhausted', $2
    ) AS result`,
    [requirementId, instanceId],
  );
  const cancelledPlan = await db.query(
    `SELECT status, steps
       FROM public.instance_plans
      WHERE id = $1`,
    [replacementPlanId],
  );

  process.stdout.write(JSON.stringify({
    rpc: rpc.rows[0]?.result,
    backlogRevision: persisted.rows[0]?.backlog_revision,
    items: persisted.rows[0]?.backlog.items,
    overloads: Object.fromEntries(
      overloads.rows.map((row) => [row.proname, row.count]),
    ),
    cleanupOnlyLegacyScope: cleanupOnlyLegacyScope.rows[0]?.result,
    legacyNoProgressScope: legacyNoProgress.rows[0],
    legacyProgressScope: legacyProgress.rows[0],
    overlappingLegacyScope: overlappingLegacyScope.rows[0]?.result,
    missingLegacyScope: missingLegacyScope.rows[0]?.result,
    atomicCancellation: atomicCancellation.rows[0]?.result,
    cancelledPlan: cancelledPlan.rows[0],
  }));
} finally {
  await db.close();
}
