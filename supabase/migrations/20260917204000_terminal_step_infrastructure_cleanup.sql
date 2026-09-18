-- Rollback:
-- Reapply 20260917203100_atomic_plan_infrastructure_state.sql.

CREATE OR REPLACE FUNCTION public.update_instance_plan_step_status_atomic(
  p_plan_id uuid,
  p_step_id text,
  p_status text,
  p_error_message text DEFAULT NULL,
  p_expected_generation integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_steps jsonb;
  v_step jsonb;
  v_step_index integer;
  v_current_status text;
  v_generation integer;
BEGIN
  IF p_status NOT IN (
    'pending',
    'in_progress',
    'completed',
    'failed',
    'cancelled'
  ) THEN
    RAISE EXCEPTION 'Unsupported plan step status: %', p_status;
  END IF;

  SELECT CASE
    WHEN jsonb_typeof(steps) = 'array' THEN steps
    ELSE '[]'::jsonb
  END
  INTO v_steps
  FROM public.instance_plans
  WHERE id = p_plan_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'persisted', false);
  END IF;

  SELECT entry.value, (entry.ordinality - 1)::integer
  INTO v_step, v_step_index
  FROM jsonb_array_elements(v_steps)
    WITH ORDINALITY AS entry(value, ordinality)
  WHERE entry.value->>'id' = p_step_id
  LIMIT 1;
  IF v_step IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'persisted', false);
  END IF;

  v_generation := CASE
    WHEN COALESCE(v_step->>'infrastructure_generation', '') ~ '^[0-9]{1,9}$'
      THEN (v_step->>'infrastructure_generation')::integer
    ELSE 0
  END;
  v_current_status := v_step->>'status';
  IF v_current_status = p_status
    AND p_status IN ('completed', 'failed', 'cancelled')
    AND (
      v_generation IS NOT DISTINCT FROM p_expected_generation
      OR v_generation::bigint IS NOT DISTINCT FROM
        p_expected_generation::bigint + 1
    )
  THEN
    RETURN jsonb_build_object(
      'state', 'duplicate',
      'persisted', true,
      'generation', v_generation
    );
  END IF;
  IF v_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object(
      'state', 'stale',
      'persisted', false,
      'generation', v_generation
    );
  END IF;
  IF v_current_status IN ('completed', 'cancelled')
    AND v_current_status <> p_status
  THEN
    RETURN jsonb_build_object(
      'state', 'terminal',
      'persisted', false,
      'generation', v_generation
    );
  END IF;

  v_step := v_step || jsonb_build_object(
    'status', p_status,
    'infrastructure_generation', v_generation + 1
  );
  IF p_status = 'in_progress' THEN
    v_step := v_step || jsonb_build_object(
      'started_at',
      COALESCE(v_step->'started_at', to_jsonb(timezone('utc', now())))
    );
  ELSIF p_status IN ('completed', 'failed', 'cancelled') THEN
    v_step := v_step || jsonb_build_object(
      'completed_at', timezone('utc', now())
    );
    IF p_status IN ('completed', 'failed') THEN
      v_step := v_step || jsonb_build_object(
        'infra_retry_count', 0,
        'infra_retry_after', NULL,
        'infrastructure_error', NULL,
        'infrastructure_waiting', false,
        'infrastructure_kind', NULL,
        'infrastructure_failure_provenance', NULL,
        'infrastructure_correlation', NULL,
        'infrastructure_state', NULL,
        'infrastructure_circuit_open', false,
        'infrastructure_intervention_required', false,
        'infrastructure_product_retry_count', NULL
      );
    END IF;
    IF p_status = 'failed' THEN
      v_step := v_step || jsonb_build_object(
        'retry_count', CASE
          WHEN COALESCE(v_step->>'retry_count', '') ~ '^[0-9]{1,9}$'
            THEN (v_step->>'retry_count')::integer + 1
          ELSE 1
        END,
        'error_message', COALESCE(p_error_message, v_step->>'error_message')
      );
    ELSIF p_status = 'completed' THEN
      v_step := v_step || jsonb_build_object('error_message', NULL);
    END IF;
  END IF;

  v_steps := jsonb_set(
    v_steps,
    ARRAY[v_step_index::text],
    v_step,
    false
  );
  UPDATE public.instance_plans
  SET steps = v_steps, updated_at = timezone('utc', now())
  WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'state', 'applied',
    'persisted', true,
    'generation', v_generation + 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_instance_plan_step_status_atomic(uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_instance_plan_step_status_atomic(uuid, text, text, text, integer) TO service_role;
