import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const db = new PGlite();
const requirementId = '10000000-0000-4000-8000-000000000001';
const siteId = '20000000-0000-4000-8000-000000000002';
const instanceId = '30000000-0000-4000-8000-000000000003';
const planId = '40000000-0000-4000-8000-000000000004';

try {
  await db.exec(`
    CREATE TABLE public.requirements (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      site_id uuid NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz
    );
    CREATE TABLE public.remote_instances (
      id uuid PRIMARY KEY
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
      accepted_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
      PRIMARY KEY (requirement_id, cycle_id)
    );
    CREATE TABLE public.requirement_status (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      requirement_id uuid NOT NULL,
      site_id uuid NOT NULL,
      instance_id uuid,
      stage text NOT NULL,
      cycle text,
      message text,
      created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
    );
  `);

  await db.query(
    `INSERT INTO public.remote_instances (id) VALUES ($1)`,
    [instanceId],
  );
  await db.query(
    `INSERT INTO public.requirements (id, status, site_id, metadata)
     VALUES ($1, 'blocked', $2, $3::jsonb)`,
    [
      requirementId,
      siteId,
      JSON.stringify({
        requirement_execution_generation: 11,
        runner_instance_id: instanceId,
        cron_infrastructure_failure_cycles: 4,
        cron_blocker_provenance: 'cron_infrastructure',
        cron_blocker_version: 1,
        cron_blocker_event_id: 'retry-4',
      }),
    ],
  );

  const outcomes = [
    ['retry-1', '2026-09-21T23:03:00.000Z', 'infrastructure_retry'],
    ['wait-1', '2026-09-21T23:04:00.000Z', 'infrastructure_wait'],
    ['remediation-1', '2026-09-21T23:05:00.000Z', 'remediation_handoff'],
    ['retry-2', '2026-09-21T23:10:00.000Z', 'infrastructure_retry'],
    ['wait-2', '2026-09-21T23:11:00.000Z', 'infrastructure_wait'],
    ['remediation-2', '2026-09-21T23:12:00.000Z', 'remediation_handoff'],
    ['retry-3', '2026-09-21T23:17:00.000Z', 'infrastructure_retry'],
    ['wait-3', '2026-09-21T23:18:00.000Z', 'infrastructure_wait'],
    ['remediation-3', '2026-09-21T23:19:00.000Z', 'remediation_handoff'],
    ['retry-4', '2026-09-21T23:25:00.000Z', 'infrastructure_retry'],
  ];
  for (const [cycleId, startedAt, outcome] of outcomes) {
    await db.query(
      `INSERT INTO public.requirement_cron_cycle_outcomes (
         requirement_id, cycle_id, cycle_started_at, execution_generation,
         outcome, runner_instance_id, plan_id, step_id
       )
       VALUES ($1, $2, $3, 11, $4, $5, $6, 'step-1')`,
      [requirementId, cycleId, startedAt, outcome, instanceId, planId],
    );
  }

  const migration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260922041000_reset_infrastructure_retry_streak_on_remediation.sql',
  ), 'utf8');
  await db.exec(migration.slice(
    0,
    migration.indexOf('\nREVOKE ALL ON FUNCTION'),
  ));
  await db.exec(migration.slice(
    migration.indexOf('\nDO $migration$'),
  ));

  const repaired = await db.query(
    `SELECT status,
            metadata->>'cron_infrastructure_failure_cycles' AS retry_streak,
            metadata->>'cron_blocker_provenance' AS blocker
       FROM public.requirements
      WHERE id = $1`,
    [requirementId],
  );
  const audit = await db.query(
    `SELECT stage, cycle
       FROM public.requirement_status
      WHERE requirement_id = $1`,
    [requirementId],
  );
  const remediation = await db.query(
    `SELECT public.record_requirement_cron_cycle_outcome(
      $1, 'remediation-4', '2026-09-21T23:27:00.000Z',
      'remediation_handoff', 11, $2, $3, 'step-1'
    ) AS result`,
    [requirementId, instanceId, planId],
  );
  const retry = await db.query(
    `SELECT public.record_requirement_cron_cycle_outcome(
      $1, 'retry-5', '2026-09-21T23:28:00.000Z',
      'infrastructure_retry', 11, $2, $3, 'step-1'
    ) AS result`,
    [requirementId, instanceId, planId],
  );

  process.stdout.write(JSON.stringify({
    repaired: repaired.rows[0],
    audit: audit.rows[0],
    remediation: remediation.rows[0].result,
    retry: retry.rows[0].result,
  }));
} finally {
  await db.close();
}
