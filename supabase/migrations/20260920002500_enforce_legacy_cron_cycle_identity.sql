-- Rollback:
-- Reapply 20260919203000_restore_scoped_rpc_compatibility.sql to restore
-- temporal legacy scope inference.

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
BEGIN
  IF p_outcome IN ('progress', 'product_no_progress') THEN
    WITH candidates AS (
      SELECT
        plan.id AS plan_id,
        entry.value->>'id' AS step_id
      FROM public.instance_plans AS plan
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(plan.steps) = 'array'
          THEN plan.steps ELSE '[]'::jsonb END
      ) AS entry(value)
      WHERE (
          p_runner_instance_id IS NULL
          OR plan.instance_id = p_runner_instance_id
        )
        AND plan.metadata->>'requirement_id' = p_requirement_id::text
        AND entry.value->'metadata'->>'cron_cycle_id' = p_cycle_id
        AND COALESCE(
          entry.value->'metadata'->>'cron_execution_generation',
          ''
        ) ~ '^[0-9]{1,9}$'
        AND (
          entry.value->'metadata'->>'cron_execution_generation'
        )::integer = p_expected_execution_generation
        AND (
          entry.value->>'status' IN ('pending', 'in_progress', 'failed')
          OR (
            p_outcome = 'progress'
            AND entry.value->>'status' = 'completed'
          )
        )
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

REVOKE ALL ON FUNCTION public.record_requirement_cron_cycle_outcome(
  uuid, text, timestamptz, text, integer, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_requirement_cron_cycle_outcome(
  uuid, text, timestamptz, text, integer, uuid
) TO service_role;
