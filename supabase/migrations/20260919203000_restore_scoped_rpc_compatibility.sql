-- Rollback:
-- DROP FUNCTION IF EXISTS public.record_requirement_cron_cycle_outcome(
--   uuid, text, timestamptz, text, integer, uuid
-- );
-- DROP FUNCTION IF EXISTS public.block_requirement_for_product_no_progress(
--   uuid, uuid, uuid, text, integer, text, integer
-- );

-- Restore overloads that an earlier deployed version of the scoped-accounting
-- migration removed. These wrappers keep rolling deployments compatible while
-- delegating all writes to the current generation- and scope-aware functions.
CREATE OR REPLACE FUNCTION public.record_requirement_cron_cycle_outcome(
  p_requirement_id uuid,
  p_cycle_id text,
  p_cycle_started_at timestamptz,
  p_outcome text,
  p_expected_execution_generation integer,
  p_runner_instance_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan_id uuid;
  v_step_id text;
  v_metadata jsonb;
  v_next_cycle_started_at timestamptz;
BEGIN
  IF p_outcome IN ('progress', 'product_no_progress') THEN
    SELECT min(cycle_started_at)
    INTO v_next_cycle_started_at
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND (cycle_started_at, cycle_id) >
        (p_cycle_started_at, p_cycle_id);

    WITH candidates AS (
      SELECT
        plan.id AS plan_id,
        entry.value->>'id' AS step_id
      FROM public.instance_plans AS plan
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(plan.steps) = 'array'
          THEN plan.steps ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS entry(value, ordinality)
      WHERE (
          p_runner_instance_id IS NULL
          OR plan.instance_id = p_runner_instance_id
        )
        AND plan.metadata->>'requirement_id' = p_requirement_id::text
        AND plan.created_at <= p_cycle_started_at
        AND (
          entry.value->>'status' IN ('pending', 'in_progress', 'failed')
          OR (
            p_outcome = 'progress'
            AND entry.value->>'status' = 'completed'
          )
        )
        AND CASE
          WHEN COALESCE(entry.value->>'started_at', '') ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
          THEN (entry.value->>'started_at')::timestamptz >=
            p_cycle_started_at
            AND (
              v_next_cycle_started_at IS NULL
              OR (entry.value->>'started_at')::timestamptz <
                v_next_cycle_started_at
            )
          ELSE false
        END
    ),
    counted_candidates AS (
      SELECT
        plan_id,
        step_id,
        count(*) OVER () AS candidate_count
      FROM candidates
    )
    SELECT
      plan_id,
      step_id
    INTO v_plan_id, v_step_id
    FROM counted_candidates
    WHERE candidate_count = 1;

    IF p_outcome = 'product_no_progress'
      AND (v_plan_id IS NULL OR v_step_id IS NULL)
    THEN
      SELECT CASE
        WHEN jsonb_typeof(metadata) = 'object' THEN metadata
        ELSE '{}'::jsonb
      END
      INTO v_metadata
      FROM public.requirements
      WHERE id = p_requirement_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Requirement % not found', p_requirement_id;
      END IF;
      RETURN jsonb_build_object(
        'accepted', false,
        'is_latest', false,
        'recorded_outcome', p_outcome,
        'metadata', v_metadata,
        'cron_attempts', CASE
          WHEN COALESCE(v_metadata->>'cron_attempts', '') ~ '^[0-9]{1,9}$'
            THEN (v_metadata->>'cron_attempts')::integer ELSE 0 END,
        'no_progress_cycles', CASE
          WHEN COALESCE(v_metadata->>'no_progress_cycles', '') ~
            '^[0-9]{1,9}$'
            THEN (v_metadata->>'no_progress_cycles')::integer ELSE 0 END,
        'infrastructure_failure_cycles', CASE
          WHEN COALESCE(
            v_metadata->>'cron_infrastructure_failure_cycles', ''
          ) ~ '^[0-9]{1,9}$'
            THEN (
              v_metadata->>'cron_infrastructure_failure_cycles'
            )::integer
          ELSE 0
        END,
        'plan_id', NULL,
        'step_id', NULL
      );
    END IF;
  END IF;

  RETURN public.record_requirement_cron_cycle_outcome(
    p_requirement_id,
    p_cycle_id,
    p_cycle_started_at,
    p_outcome,
    p_expected_execution_generation,
    p_runner_instance_id,
    v_plan_id,
    v_step_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.block_requirement_for_product_no_progress(
  p_requirement_id uuid,
  p_site_id uuid,
  p_instance_id uuid,
  p_cycle_id text,
  p_minimum_failures integer,
  p_message text,
  p_expected_execution_generation integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan_id uuid;
  v_step_id text;
  v_step_generation integer;
BEGIN
  SELECT
    plan.id,
    entry.value->>'id',
    CASE
      WHEN COALESCE(
        entry.value->>'infrastructure_generation',
        ''
      ) ~ '^[0-9]{1,9}$'
        THEN (entry.value->>'infrastructure_generation')::integer
      ELSE 0
    END
  INTO v_plan_id, v_step_id, v_step_generation
  FROM public.instance_plans AS plan
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(plan.steps) = 'array'
      THEN plan.steps ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS entry(value, ordinality)
  WHERE plan.instance_id = p_instance_id
    AND plan.metadata->>'requirement_id' = p_requirement_id::text
    AND plan.status IN ('pending', 'in_progress', 'active')
    AND entry.value->>'status' IN ('pending', 'in_progress', 'failed')
  ORDER BY plan.updated_at DESC, plan.id, entry.ordinality
  LIMIT 1;

  IF v_plan_id IS NULL OR v_step_id IS NULL THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;

  RETURN public.block_requirement_for_product_no_progress(
    p_requirement_id,
    p_site_id,
    p_instance_id,
    p_cycle_id,
    p_minimum_failures,
    p_message,
    p_expected_execution_generation,
    v_plan_id,
    v_step_id,
    v_step_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_requirement_cron_cycle_outcome(
  uuid, text, timestamptz, text, integer, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_requirement_for_product_no_progress(
  uuid, uuid, uuid, text, integer, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_requirement_cron_cycle_outcome(
  uuid, text, timestamptz, text, integer, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.block_requirement_for_product_no_progress(
  uuid, uuid, uuid, text, integer, text, integer
) TO service_role;
