import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const db = new PGlite();
const requirementId = '10000000-0000-4000-8000-000000000001';
const lateRequirementId = '20000000-0000-4000-8000-000000000002';
const instanceId = '30000000-0000-4000-8000-000000000003';
const actionId = '40000000-0000-4000-8000-000000000004';
const oldActionId = '50000000-0000-4000-8000-000000000005';
const systemRequirementId = '60000000-0000-4000-8000-000000000006';
const lateActionId = '70000000-0000-4000-8000-000000000007';
const nextActionId = '80000000-0000-4000-8000-000000000008';

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE TABLE public.requirements (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      backlog jsonb NOT NULL DEFAULT '{}'::jsonb,
      backlog_revision bigint NOT NULL DEFAULT 0,
      updated_at timestamptz
    );
    CREATE TABLE public.instance_logs (
      id uuid PRIMARY KEY,
      instance_id uuid,
      log_type text NOT NULL,
      details jsonb,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE public.instance_plans (
      id uuid PRIMARY KEY,
      instance_id uuid NOT NULL,
      status text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      steps jsonb NOT NULL DEFAULT '[]'::jsonb,
      completed_at timestamptz,
      updated_at timestamptz
    );
    CREATE TABLE public.remote_instances (
      id uuid PRIMARY KEY,
      status text NOT NULL
    );
    CREATE FUNCTION public.check_create_update_permission()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF COALESCE(
        current_setting('request.jwt.claims', true)::jsonb->>'role',
        ''
      ) <> 'service_role' THEN
        RAISE EXCEPTION
          'CREATE_UPDATE_PERMISSION_DENIED: Authentication required';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER requirements_create_update_permission
      BEFORE UPDATE ON public.requirements
      FOR EACH ROW
      EXECUTE FUNCTION public.check_create_update_permission();
  `);

  await db.query(
    `INSERT INTO public.requirements
      (id, status, metadata, backlog, updated_at)
     VALUES ($1, 'on-review', $2::jsonb, $3::jsonb, $4)`,
    [
      requirementId,
      JSON.stringify({
        runner_instance_id: instanceId,
        requirement_execution_generation: 2,
      }),
      JSON.stringify({
        items: [{
          id: 'item-1',
          phase_id: 'build',
          status: 'needs_review',
          attempts: 4,
          updated_at: '2026-09-23T20:00:00.000Z',
          tool_failures: {
            judge_capability_resolver: 2,
            sandbox_db_migrate: 1,
          },
        }],
        current_phase_id: 'review',
      }),
      '2026-09-23T20:00:00.000Z',
    ],
  );
  await db.query(
    `INSERT INTO public.instance_logs
      (id, instance_id, log_type, details, created_at)
     VALUES ($1, $2, 'user_action', $3::jsonb, $4)`,
    [
      oldActionId,
      instanceId,
      JSON.stringify({ requirement_id: lateRequirementId }),
      '2026-09-23T19:00:00.000Z',
    ],
  );

  const receiptMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260923225900_review_quarantine_receipts.sql',
  ), 'utf8');
  await db.exec(receiptMigration);
  const migration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260923230000_durable_review_quarantine.sql',
  ), 'utf8');
  await db.exec(migration);
  const backfillMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260923230050_backfill_review_quarantine.sql',
  ), 'utf8');
  await db.exec(backfillMigration);
  await db.query(
    `SELECT pg_catalog.set_config(
      'request.jwt.claims',
      '{"role":"service_role"}',
      false
    )`,
  );
  const stampMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260923230100_stamp_review_quarantine.sql',
  ), 'utf8');
  await db.exec(stampMigration);

  const backfilled = await db.query(
    `SELECT backlog, backlog_revision
     FROM public.requirements WHERE id = $1`,
    [requirementId],
  );

  let directReopenRejected = false;
  try {
    await db.query(
      `UPDATE public.requirements
       SET backlog = jsonb_set(
         backlog,
         '{items,0,status}',
         '"pending"'::jsonb
       )
       WHERE id = $1`,
      [requirementId],
    );
  } catch (error) {
    directReopenRejected = String(error).includes('quarantined');
  }

  const untrusted = await db.query(
    `SELECT public.resume_instance_execution_on_user_action(
      $1, $2, true, $3, false
    ) AS result`,
    [requirementId, instanceId, oldActionId],
  );
  await db.query(
    `INSERT INTO public.instance_logs
      (
        id, instance_id, log_type, details, created_at,
        trusted_user_action
      )
     VALUES ($1, $2, 'user_action', $3::jsonb, $4, true)`,
    [
      actionId,
      instanceId,
      JSON.stringify({ requirement_id: requirementId }),
      '2026-09-23T21:00:00.000Z',
    ],
  );
  const release = await db.query(
    `SELECT public.resume_instance_execution_on_user_action(
      $1, $2, true, $3, false
    ) AS result`,
    [requirementId, instanceId, actionId],
  );
  const released = await db.query(
    `SELECT
       backlog,
       backlog_revision,
       external_user_action_revision,
       last_external_user_action_id
     FROM public.requirements
     WHERE id = $1`,
    [requirementId],
  );
  const duplicate = await db.query(
    `SELECT public.resume_instance_execution_on_user_action(
      $1, $2, true, $3, false
    ) AS result`,
    [requirementId, instanceId, actionId],
  );
  await db.query(
    `INSERT INTO public.instance_logs
      (
        id, instance_id, log_type, details, created_at,
        trusted_user_action
      )
     VALUES ($1, $2, 'user_action', $3::jsonb, $4, true)`,
    [
      nextActionId,
      instanceId,
      JSON.stringify({ requirement_id: requirementId }),
      '2026-09-23T21:30:00.000Z',
    ],
  );
  const nextAction = await db.query(
    `SELECT public.resume_instance_execution_on_user_action(
      $1, $2, true, $3, false
    ) AS result`,
    [requirementId, instanceId, nextActionId],
  );
  const replayAfterNewerAction = await db.query(
    `SELECT public.resume_instance_execution_on_user_action(
      $1, $2, true, $3, false
    ) AS result`,
    [requirementId, instanceId, actionId],
  );

  await db.query(
    `INSERT INTO public.requirements
      (
        id, status, metadata, backlog, backlog_revision,
        external_user_action_revision, updated_at
      )
     VALUES ($1, 'in-progress', $2::jsonb, $3::jsonb, 0, 0, $4)`,
    [
      lateRequirementId,
      JSON.stringify({ runner_instance_id: instanceId }),
      JSON.stringify({
        items: [{
          id: 'late-item',
          status: 'needs_review',
          attempts: 2,
          updated_at: '2026-09-23T22:00:00.000Z',
          review_quarantine: {
            active: true,
            kind: 'manual',
            reason: 'Needs later input',
            quarantined_at: '2026-09-23T22:00:00.000Z',
            external_action_revision: 0,
          },
        }],
      }),
      '2026-09-23T22:00:00.000Z',
    ],
  );
  await db.query(
    `UPDATE public.instance_logs
     SET trusted_user_action = true
     WHERE id = $1`,
    [oldActionId],
  );
  const oldAction = await db.query(
    `SELECT public.resume_instance_execution_on_user_action(
      $1, $2, true, $3, false
    ) AS result`,
    [lateRequirementId, instanceId, oldActionId],
  );
  const lateRequirementBefore = await db.query(
    'SELECT backlog FROM public.requirements WHERE id = $1',
    [lateRequirementId],
  );
  await db.query(
    `INSERT INTO public.instance_logs
      (
        id, instance_id, log_type, details, created_at,
        trusted_user_action
      )
     VALUES ($1, $2, 'user_action', $3::jsonb, $4, true)`,
    [
      lateActionId,
      instanceId,
      JSON.stringify({ requirement_id: lateRequirementId }),
      '2026-09-23T23:00:00.000Z',
    ],
  );
  const lateRelease = await db.query(
    `SELECT public.resume_instance_execution_on_user_action(
      $1, $2, true, $3, false
    ) AS result`,
    [lateRequirementId, instanceId, lateActionId],
  );
  const lateRequirementAfter = await db.query(
    'SELECT backlog FROM public.requirements WHERE id = $1',
    [lateRequirementId],
  );
  await db.query(
    `INSERT INTO public.requirements
      (id, status, metadata, backlog, updated_at)
     VALUES ($1, 'blocked', $2::jsonb, '{"items":[]}'::jsonb, now())`,
    [
      systemRequirementId,
      JSON.stringify({ runner_instance_id: instanceId }),
    ],
  );
  const internalRecovery = await db.query(
    `SELECT public.resume_instance_execution_on_user_action(
      $1, $2, false, 'system:deployment-recovered', true
    ) AS result`,
    [systemRequirementId, instanceId],
  );
  await db.query(
    `UPDATE public.requirements
     SET backlog = '{"items":[{"id":"system-item","status":"needs_review"}]}'::jsonb
     WHERE id = $1`,
    [systemRequirementId],
  );
  const stamped = await db.query(
    'SELECT backlog FROM public.requirements WHERE id = $1',
    [systemRequirementId],
  );

  console.log(JSON.stringify({
    backfilled: backfilled.rows[0],
    directReopenRejected,
    untrusted: untrusted.rows[0].result,
    release: release.rows[0].result,
    released: released.rows[0],
    duplicate: duplicate.rows[0].result,
    nextAction: nextAction.rows[0].result,
    replayAfterNewerAction: replayAfterNewerAction.rows[0].result,
    oldAction: oldAction.rows[0].result,
    lateRequirementBefore: lateRequirementBefore.rows[0],
    lateRelease: lateRelease.rows[0].result,
    lateRequirementAfter: lateRequirementAfter.rows[0],
    internalRecovery: internalRecovery.rows[0].result,
    stamped: stamped.rows[0],
  }));
} finally {
  await db.close();
}
