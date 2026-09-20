-- Rollback:
-- Drop the scoped RPCs and plan_id/step_id columns, then reapply migrations
-- 20260917203000 and 20260918020000 to restore the prior RPC definitions.

ALTER TABLE public.requirement_cron_cycle_outcomes
  ADD COLUMN IF NOT EXISTS plan_id uuid,
  ADD COLUMN IF NOT EXISTS step_id text;

DROP INDEX IF EXISTS public.requirement_cron_cycle_outcomes_scope_idx;
CREATE INDEX requirement_cron_cycle_outcomes_scope_idx
  ON public.requirement_cron_cycle_outcomes
  (requirement_id, execution_generation, plan_id, step_id,
   cycle_started_at DESC, cycle_id DESC);

ALTER TABLE public.requirement_cron_cycle_outcomes
  ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.record_requirement_cron_cycle_outcome(
  p_requirement_id uuid, p_cycle_id text, p_cycle_started_at timestamptz,
  p_outcome text, p_expected_execution_generation integer,
  p_runner_instance_id uuid, p_plan_id uuid, p_step_id text
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
  v_last_product_at timestamptz;
  v_last_product_cycle_id text;
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
      THEN (v_metadata->>'cron_attempts')::integer ELSE 0 END;
  v_no_progress_cycles := CASE
    WHEN COALESCE(v_metadata->>'no_progress_cycles', '') ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'no_progress_cycles')::integer ELSE 0 END;
  v_infrastructure_failure_cycles := CASE
    WHEN COALESCE(
      v_metadata->>'cron_infrastructure_failure_cycles', ''
    ) ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'cron_infrastructure_failure_cycles')::integer
    ELSE 0 END;

  INSERT INTO public.requirement_cron_cycle_outcomes
    (requirement_id, cycle_id, cycle_started_at, execution_generation,
     outcome, runner_instance_id, plan_id, step_id)
  VALUES
    (p_requirement_id, p_cycle_id, p_cycle_started_at,
     p_expected_execution_generation, p_outcome, p_runner_instance_id,
     p_plan_id, NULLIF(btrim(p_step_id), ''))
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
    'infrastructure_retry'
  ) THEN
    SELECT cycle_started_at, cycle_id
    INTO v_last_product_at, v_last_product_cycle_id
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND outcome IN (
        'progress',
        'product_no_progress',
        'product_failure'
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
        v_last_product_at IS NULL
        OR (cycle_started_at, cycle_id) >
          (v_last_product_at, v_last_product_cycle_id)
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
  SET metadata = v_metadata, updated_at = timezone('utc', now())
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

CREATE OR REPLACE FUNCTION public.block_requirement_for_product_no_progress(
  p_requirement_id uuid, p_site_id uuid, p_instance_id uuid,
  p_cycle_id text, p_minimum_failures integer, p_message text,
  p_expected_execution_generation integer, p_plan_id uuid,
  p_step_id text, p_expected_step_generation integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_site_id uuid;
  v_metadata jsonb;
  v_latest_cycle_id text;
  v_latest_outcome text;
  v_failure_cycles integer := 0;
  v_steps jsonb;
  v_step jsonb;
  v_step_generation integer;
  v_last_progress_at timestamptz;
  v_last_progress_cycle_id text;
  v_audit_cycle text := 'product-no-progress-circuit:' || p_cycle_id;
BEGIN
  IF p_minimum_failures IS NULL OR p_minimum_failures < 1 THEN
    RAISE EXCEPTION 'p_minimum_failures must be positive';
  END IF;

  SELECT
    status,
    site_id,
    CASE WHEN jsonb_typeof(metadata) = 'object'
      THEN metadata ELSE '{}'::jsonb END
  INTO v_status, v_site_id, v_metadata
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'blocked', false);
  END IF;
  IF v_site_id IS DISTINCT FROM p_site_id THEN
    RAISE EXCEPTION 'Requirement % does not belong to site %',
      p_requirement_id, p_site_id;
  END IF;
  IF v_status IN ('done', 'cancelled', 'canceled', 'on-review') THEN
    RETURN jsonb_build_object('state', 'guarded', 'blocked', false);
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
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;

  SELECT CASE
    WHEN jsonb_typeof(steps) = 'array' THEN steps
    ELSE '[]'::jsonb
  END
  INTO v_steps
  FROM public.instance_plans
  WHERE id = p_plan_id
    AND instance_id = p_instance_id
    AND metadata->>'requirement_id' = p_requirement_id::text
    AND status IN ('pending', 'in_progress', 'active')
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;

  SELECT entry.value
  INTO v_step
  FROM jsonb_array_elements(v_steps) AS entry(value)
  WHERE entry.value->>'id' = p_step_id
  LIMIT 1;
  IF v_step IS NULL
    OR v_step->>'status' NOT IN ('pending', 'in_progress', 'failed')
    OR COALESCE(
      v_step->'metadata'->'no_progress_adjudication'->>'state',
      ''
    ) <> 'consumed'
    OR COALESCE(
      v_step->'metadata'->'no_progress_adjudication'
        ->>'execution_generation',
      ''
    ) <> p_expected_execution_generation::text
  THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;

  v_step_generation := CASE
    WHEN COALESCE(
      v_step->>'infrastructure_generation',
      ''
    ) ~ '^[0-9]{1,9}$'
      THEN (v_step->>'infrastructure_generation')::integer
    ELSE 0
  END;
  IF v_step_generation IS DISTINCT FROM p_expected_step_generation THEN
    RETURN jsonb_build_object(
      'state', 'stale', 'blocked', false,
      'generation', v_step_generation
    );
  END IF;

  SELECT cycle_id, outcome
  INTO v_latest_cycle_id, v_latest_outcome
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
    AND execution_generation = p_expected_execution_generation
    AND plan_id = p_plan_id
    AND step_id = p_step_id
  ORDER BY cycle_started_at DESC, cycle_id DESC
  LIMIT 1;

  SELECT cycle_started_at, cycle_id
  INTO v_last_progress_at, v_last_progress_cycle_id
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
    AND execution_generation = p_expected_execution_generation
    AND plan_id = p_plan_id
    AND step_id = p_step_id
    AND outcome = 'progress'
  ORDER BY cycle_started_at DESC, cycle_id DESC
  LIMIT 1;

  SELECT count(*)::integer
  INTO v_failure_cycles
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
    AND execution_generation = p_expected_execution_generation
    AND plan_id = p_plan_id
    AND step_id = p_step_id
    AND outcome = 'product_no_progress'
    AND (
      v_last_progress_at IS NULL
      OR (cycle_started_at, cycle_id) >
        (v_last_progress_at, v_last_progress_cycle_id)
    );

  IF v_latest_cycle_id IS DISTINCT FROM p_cycle_id
    OR v_latest_outcome <> 'product_no_progress'
    OR v_failure_cycles < p_minimum_failures
  THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;

  UPDATE public.requirements
  SET
    status = 'blocked',
    metadata = v_metadata || jsonb_build_object(
      'cron_blocker_provenance', 'product_no_progress_circuit',
      'cron_blocker_version', 2,
      'cron_blocker_event_id', p_cycle_id,
      'cron_blocker_plan_id', p_plan_id::text,
      'cron_blocker_step_id', p_step_id,
      'cron_blocker_generation', p_expected_step_generation
    ),
    updated_at = timezone('utc', now())
  WHERE id = p_requirement_id;

  IF NOT EXISTS (
    SELECT 1
    FROM public.requirement_status
    WHERE requirement_id = p_requirement_id
      AND cycle = v_audit_cycle
  ) THEN
    INSERT INTO public.requirement_status (
      requirement_id,
      site_id,
      instance_id,
      stage,
      cycle,
      message
    )
    VALUES (
      p_requirement_id,
      p_site_id,
      p_instance_id,
      'blocked',
      v_audit_cycle,
      p_message
    );
  END IF;

  RETURN jsonb_build_object(
    'state', 'applied',
    'blocked', true,
    'generation', v_step_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_requirement_cron_cycle_outcome(uuid, text, timestamptz, text, integer, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_requirement_for_product_no_progress(uuid, uuid, uuid, text, integer, text, integer, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_requirement_cron_cycle_outcome(uuid, text, timestamptz, text, integer, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.block_requirement_for_product_no_progress(uuid, uuid, uuid, text, integer, text, integer, uuid, text, integer) TO service_role;
