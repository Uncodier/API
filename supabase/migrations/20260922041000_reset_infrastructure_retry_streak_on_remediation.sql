-- Rollback:
-- Reapply supabase/migrations/20260919165000_scope_cron_no_progress.sql to
-- restore the previous infrastructure retry accounting. Requirements reopened
-- by the normalization below must be reviewed manually before re-blocking.

CREATE OR REPLACE FUNCTION public.record_requirement_cron_cycle_outcome(
  p_requirement_id uuid,
  p_cycle_id text,
  p_cycle_started_at timestamptz,
  p_outcome text,
  p_expected_execution_generation integer,
  p_runner_instance_id uuid,
  p_plan_id uuid,
  p_step_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_metadata jsonb;
  v_inserted boolean := false;
  v_recorded_outcome text;
  v_latest_cycle_id text;
  v_latest_outcome text;
  v_latest_started_at timestamptz;
  v_latest_runner_instance_id uuid;
  v_latest_plan_id uuid;
  v_latest_step_id text;
  v_last_progress_at timestamptz;
  v_last_progress_cycle_id text;
  v_last_scoped_progress_at timestamptz;
  v_last_scoped_progress_cycle_id text;
  v_last_recovery_at timestamptz;
  v_last_recovery_cycle_id text;
  v_cron_attempts integer := 0;
  v_no_progress_cycles integer := 0;
  v_infrastructure_failure_cycles integer := 0;
  v_allowed_outcomes constant text[] := ARRAY[
    'progress', 'product_no_progress', 'product_failure',
    'infrastructure_wait', 'infrastructure_retry',
    'infrastructure_exhausted', 'scheduler_cooldown',
    'remediation_handoff', 'paused', 'idle'
  ];
BEGIN
  IF NULLIF(btrim(p_cycle_id), '') IS NULL
    OR char_length(p_cycle_id) > 200
  THEN
    RAISE EXCEPTION 'p_cycle_id must contain 1 to 200 characters';
  END IF;
  IF p_cycle_started_at IS NULL
    OR p_cycle_started_at > timezone('utc', now()) + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'p_cycle_started_at is invalid';
  END IF;
  IF NOT (p_outcome = ANY(v_allowed_outcomes)) THEN
    RAISE EXCEPTION 'Unsupported cron cycle outcome: %', p_outcome;
  END IF;
  IF (p_plan_id IS NULL) IS DISTINCT FROM
    (NULLIF(btrim(p_step_id), '') IS NULL)
  THEN
    RAISE EXCEPTION 'p_plan_id and p_step_id must be provided together';
  END IF;
  IF p_outcome = 'product_no_progress' AND p_plan_id IS NULL THEN
    RAISE EXCEPTION 'product_no_progress requires plan and step scope';
  END IF;

  SELECT CASE
    WHEN jsonb_typeof(metadata) = 'object' THEN metadata
    ELSE '{}'::jsonb
  END
  INTO v_metadata
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Requirement % not found', p_requirement_id;
  END IF;
  IF (
    CASE
      WHEN COALESCE(
        v_metadata->>'requirement_execution_generation',
        ''
      ) ~ '^[0-9]{1,9}$'
        THEN (v_metadata->>'requirement_execution_generation')::integer
      ELSE 0
    END
  ) IS DISTINCT FROM p_expected_execution_generation THEN
    RETURN jsonb_build_object(
      'accepted', false,
      'is_latest', false,
      'recorded_outcome', p_outcome,
      'metadata', v_metadata,
      'cron_attempts', 0,
      'no_progress_cycles', 0,
      'infrastructure_failure_cycles', 0
    );
  END IF;
  v_cron_attempts := CASE
    WHEN COALESCE(v_metadata->>'cron_attempts', '') ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'cron_attempts')::integer
    ELSE 0
  END;
  v_no_progress_cycles := CASE
    WHEN COALESCE(v_metadata->>'no_progress_cycles', '') ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'no_progress_cycles')::integer
    ELSE 0
  END;
  v_infrastructure_failure_cycles := CASE
    WHEN COALESCE(
      v_metadata->>'cron_infrastructure_failure_cycles',
      ''
    ) ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'cron_infrastructure_failure_cycles')::integer
    ELSE 0
  END;

  INSERT INTO public.requirement_cron_cycle_outcomes (
    requirement_id,
    cycle_id,
    cycle_started_at,
    execution_generation,
    outcome,
    runner_instance_id,
    plan_id,
    step_id
  )
  VALUES (
    p_requirement_id,
    p_cycle_id,
    p_cycle_started_at,
    p_expected_execution_generation,
    p_outcome,
    p_runner_instance_id,
    p_plan_id,
    NULLIF(btrim(p_step_id), '')
  )
  ON CONFLICT (requirement_id, cycle_id) DO NOTHING
  RETURNING true INTO v_inserted;

  SELECT outcome
  INTO v_recorded_outcome
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
    AND cycle_id = p_cycle_id;

  SELECT
    cycle_id,
    outcome,
    cycle_started_at,
    runner_instance_id,
    plan_id,
    step_id
  INTO
    v_latest_cycle_id,
    v_latest_outcome,
    v_latest_started_at,
    v_latest_runner_instance_id,
    v_latest_plan_id,
    v_latest_step_id
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
    AND execution_generation = p_expected_execution_generation
  ORDER BY cycle_started_at DESC, cycle_id DESC
  LIMIT 1;

  SELECT cycle_started_at, cycle_id
  INTO v_last_progress_at, v_last_progress_cycle_id
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
    AND execution_generation = p_expected_execution_generation
    AND outcome = 'progress'
  ORDER BY cycle_started_at DESC, cycle_id DESC
  LIMIT 1;

  IF v_latest_outcome IN (
    'progress',
    'product_no_progress',
    'product_failure'
  ) THEN
    SELECT count(*) FILTER (
      WHERE outcome IN ('product_no_progress', 'product_failure')
    )::integer
    INTO v_cron_attempts
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND (
        v_last_progress_at IS NULL
        OR (cycle_started_at, cycle_id) >
          (v_last_progress_at, v_last_progress_cycle_id)
      );

    SELECT cycle_started_at, cycle_id
    INTO v_last_scoped_progress_at, v_last_scoped_progress_cycle_id
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND plan_id IS NOT DISTINCT FROM v_latest_plan_id
      AND step_id IS NOT DISTINCT FROM v_latest_step_id
      AND outcome = 'progress'
    ORDER BY cycle_started_at DESC, cycle_id DESC
    LIMIT 1;

    SELECT count(*)::integer
    INTO v_no_progress_cycles
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND plan_id IS NOT DISTINCT FROM v_latest_plan_id
      AND step_id IS NOT DISTINCT FROM v_latest_step_id
      AND outcome = 'product_no_progress'
      AND (
        v_last_scoped_progress_at IS NULL
        OR (cycle_started_at, cycle_id) >
          (
            v_last_scoped_progress_at,
            v_last_scoped_progress_cycle_id
          )
      );

    v_metadata := v_metadata || jsonb_build_object(
      'cron_attempts', COALESCE(v_cron_attempts, 0),
      'no_progress_cycles', COALESCE(v_no_progress_cycles, 0),
      'cron_no_progress_plan_id', v_latest_plan_id,
      'cron_no_progress_step_id', v_latest_step_id
    );
  END IF;

  IF v_latest_outcome IN (
    'progress',
    'product_no_progress',
    'product_failure',
    'remediation_handoff',
    'infrastructure_retry'
  ) THEN
    SELECT cycle_started_at, cycle_id
    INTO v_last_recovery_at, v_last_recovery_cycle_id
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND outcome IN (
        'progress',
        'product_no_progress',
        'product_failure',
        'remediation_handoff'
      )
    ORDER BY cycle_started_at DESC, cycle_id DESC
    LIMIT 1;

    SELECT count(*)::integer
    INTO v_infrastructure_failure_cycles
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND outcome = 'infrastructure_retry'
      AND (
        v_last_recovery_at IS NULL
        OR (cycle_started_at, cycle_id) >
          (v_last_recovery_at, v_last_recovery_cycle_id)
      );

    v_metadata := v_metadata || jsonb_build_object(
      'cron_infrastructure_failure_cycles',
      COALESCE(v_infrastructure_failure_cycles, 0)
    );
  END IF;

  v_metadata := v_metadata || jsonb_build_object(
    'cron_last_cycle_id', v_latest_cycle_id,
    'cron_last_cycle_outcome', v_latest_outcome,
    'cron_last_cycle_at', v_latest_started_at
  );
  IF v_last_progress_cycle_id IS NOT NULL THEN
    v_metadata := v_metadata || jsonb_build_object(
      'cron_last_progress_cycle_id', v_last_progress_cycle_id
    );
  END IF;
  IF v_latest_runner_instance_id IS NOT NULL THEN
    v_metadata := v_metadata || jsonb_build_object(
      'runner_instance_id', v_latest_runner_instance_id
    );
  END IF;

  UPDATE public.requirements
  SET
    metadata = v_metadata,
    updated_at = timezone('utc', now())
  WHERE id = p_requirement_id;

  RETURN jsonb_build_object(
    'accepted', v_inserted IS TRUE,
    'is_latest', p_cycle_id = v_latest_cycle_id,
    'recorded_outcome', v_recorded_outcome,
    'metadata', v_metadata,
    'cron_attempts', COALESCE(v_cron_attempts, 0),
    'no_progress_cycles', COALESCE(v_no_progress_cycles, 0),
    'infrastructure_failure_cycles',
      COALESCE(v_infrastructure_failure_cycles, 0),
    'plan_id', v_latest_plan_id,
    'step_id', v_latest_step_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_requirement_cron_cycle_outcome(
  uuid, text, timestamptz, text, integer, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_requirement_cron_cycle_outcome(
  uuid, text, timestamptz, text, integer, uuid, uuid, text
) TO service_role;

DO $migration$
BEGIN
  -- The requirements update trigger authorizes service-role JWTs rather than
  -- migration sessions. Keep the bypass transaction-local and leave the
  -- trigger enabled.
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );

  WITH false_infrastructure_blocks AS (
  SELECT
    requirement.id,
    requirement.site_id,
    runner.id AS instance_id,
    COALESCE((
      SELECT count(*)::integer
      FROM public.requirement_cron_cycle_outcomes AS retry
      WHERE retry.requirement_id = requirement.id
        AND retry.execution_generation = CASE
          WHEN COALESCE(
            requirement.metadata->>'requirement_execution_generation',
            ''
          ) ~ '^[0-9]{1,9}$'
            THEN (
              requirement.metadata->>'requirement_execution_generation'
            )::integer
          ELSE 0
        END
        AND retry.outcome = 'infrastructure_retry'
        AND NOT EXISTS (
          SELECT 1
          FROM public.requirement_cron_cycle_outcomes AS recovery
          WHERE recovery.requirement_id = requirement.id
            AND recovery.execution_generation = retry.execution_generation
            AND recovery.outcome IN (
              'progress',
              'product_no_progress',
              'product_failure',
              'remediation_handoff'
            )
            AND (
              recovery.cycle_started_at,
              recovery.cycle_id
            ) > (
              retry.cycle_started_at,
              retry.cycle_id
            )
        )
    ), 0) AS retry_streak
  FROM public.requirements AS requirement
  LEFT JOIN public.remote_instances AS runner
    ON runner.id::text = requirement.metadata->>'runner_instance_id'
  WHERE requirement.status = 'blocked'
    AND requirement.metadata->>'cron_blocker_provenance' =
      'cron_infrastructure'
    AND COALESCE(
      requirement.metadata->>'requirement_execution_generation',
      ''
    ) ~ '^[0-9]{1,9}$'
),
reopened AS (
  UPDATE public.requirements AS requirement
  SET
    status = 'in-progress',
    metadata = (
      requirement.metadata - ARRAY[
        'cron_blocker_provenance',
        'cron_blocker_version',
        'cron_blocker_event_id',
        'cron_blocker_plan_id',
        'cron_blocker_step_id',
        'cron_blocker_generation'
      ]
    ) || jsonb_build_object(
      'cron_infrastructure_failure_cycles',
      false_block.retry_streak
    ),
    updated_at = timezone('utc', now())
  FROM false_infrastructure_blocks AS false_block
  WHERE requirement.id = false_block.id
    AND false_block.retry_streak < 4
  RETURNING
    requirement.id,
    requirement.site_id,
    false_block.instance_id,
    false_block.retry_streak
)
INSERT INTO public.requirement_status (
  requirement_id,
  site_id,
  instance_id,
  stage,
  cycle,
  message
)
SELECT
  reopened.id,
  reopened.site_id,
  reopened.instance_id,
  'in-progress',
  'infrastructure-counter-normalization-v2',
  'Automatic execution resumed after correcting the infrastructure retry ' ||
    'streak from an accumulated count to ' || reopened.retry_streak || '.'
FROM reopened
WHERE NOT EXISTS (
  SELECT 1
  FROM public.requirement_status AS status
  WHERE status.requirement_id = reopened.id
    AND status.cycle = 'infrastructure-counter-normalization-v2'
);
END;
$migration$;
