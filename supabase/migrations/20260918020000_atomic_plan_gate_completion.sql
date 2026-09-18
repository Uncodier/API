-- Rollback:
-- DROP FUNCTION IF EXISTS public.complete_instance_plan_step_after_gate(uuid, text, integer, boolean);
-- DROP FUNCTION IF EXISTS public.reconcile_instance_plan_status_atomic(uuid);
-- DROP FUNCTION IF EXISTS public.block_requirement_for_product_no_progress(uuid, uuid, uuid, text, integer, text, integer, uuid, text, integer);

CREATE OR REPLACE FUNCTION public.complete_instance_plan_step_after_gate(
  p_plan_id uuid,
  p_step_id text,
  p_expected_generation integer,
  p_final_gate_approved boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan_status text;
  v_steps jsonb;
  v_step jsonb;
  v_step_index integer;
  v_generation integer;
  v_final boolean;
  v_completed_count integer;
BEGIN
  SELECT
    status,
    CASE WHEN jsonb_typeof(steps) = 'array' THEN steps ELSE '[]'::jsonb END
  INTO v_plan_status, v_steps
  FROM public.instance_plans
  WHERE id = p_plan_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'state', 'missing', 'persisted', false, 'final', false
    );
  END IF;

  SELECT entry.value, (entry.ordinality - 1)::integer
  INTO v_step, v_step_index
  FROM jsonb_array_elements(v_steps)
    WITH ORDINALITY AS entry(value, ordinality)
  WHERE entry.value->>'id' = p_step_id
  LIMIT 1;
  IF v_step IS NULL OR (
    SELECT count(*) FROM jsonb_array_elements(v_steps) AS entry(value)
    WHERE entry.value->>'id' = p_step_id
  ) <> 1 THEN
    RETURN jsonb_build_object(
      'state', 'missing', 'persisted', false, 'final', false
    );
  END IF;

  v_generation := CASE
    WHEN COALESCE(v_step->>'infrastructure_generation', '') ~ '^[0-9]{1,9}$'
      THEN (v_step->>'infrastructure_generation')::integer
    ELSE 0
  END;
  IF v_step->>'status' = 'completed'
    AND (
      v_generation IS NOT DISTINCT FROM p_expected_generation
      OR v_generation::bigint IS NOT DISTINCT FROM
        p_expected_generation::bigint + 1
    )
  THEN
    SELECT bool_and(entry.value->>'status' = 'completed')
    INTO v_final
    FROM jsonb_array_elements(v_steps) AS entry(value);
    RETURN jsonb_build_object(
      'state', 'duplicate',
      'persisted', true,
      'final', COALESCE(v_final, false),
      'generation', v_generation
    );
  END IF;
  IF v_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object(
      'state', 'stale', 'persisted', false, 'final', false,
      'generation', v_generation
    );
  END IF;
  IF v_step->>'status' = 'cancelled' THEN
    RETURN jsonb_build_object(
      'state', 'terminal', 'persisted', false, 'final', false,
      'generation', v_generation
    );
  END IF;

  v_step := v_step || jsonb_build_object(
    'status', 'completed',
    'completed_at', timezone('utc', now()),
    'error_message', NULL,
    'infrastructure_generation', v_generation + 1
  );
  v_steps := jsonb_set(
    v_steps, ARRAY[v_step_index::text], v_step, false
  );
  SELECT
    bool_and(entry.value->>'status' = 'completed'),
    count(*) FILTER (WHERE entry.value->>'status' = 'completed')
  INTO v_final, v_completed_count
  FROM jsonb_array_elements(v_steps) AS entry(value);

  IF COALESCE(v_final, false) AND NOT p_final_gate_approved THEN
    RETURN jsonb_build_object(
      'state', 'guarded',
      'persisted', false,
      'final', true,
      'generation', v_generation
    );
  END IF;

  UPDATE public.instance_plans
  SET
    steps = v_steps,
    status = CASE
      WHEN COALESCE(v_final, false) THEN 'completed'
      WHEN v_plan_status IN ('pending', 'cancelled') THEN 'in_progress'
      ELSE v_plan_status
    END,
    steps_completed = v_completed_count,
    progress_percentage = CASE
      WHEN jsonb_array_length(v_steps) = 0 THEN 0
      ELSE round(
        (v_completed_count::numeric / jsonb_array_length(v_steps)) * 100
      )::integer
    END,
    completed_at = CASE
      WHEN COALESCE(v_final, false) THEN timezone('utc', now())
      ELSE NULL
    END,
    updated_at = timezone('utc', now())
  WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'state', 'applied',
    'persisted', true,
    'final', COALESCE(v_final, false),
    'generation', v_generation + 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_instance_plan_status_atomic(
  p_plan_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_steps jsonb;
  v_total integer;
  v_completed integer;
  v_has_runnable boolean;
  v_has_failed boolean;
  v_has_cancelled boolean;
  v_next_status text;
BEGIN
  SELECT
    status,
    CASE WHEN jsonb_typeof(steps) = 'array' THEN steps ELSE '[]'::jsonb END
  INTO v_status, v_steps
  FROM public.instance_plans
  WHERE id = p_plan_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'status', 'unknown');
  END IF;
  IF v_status = 'paused' THEN
    RETURN jsonb_build_object('state', 'guarded', 'status', v_status);
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE entry.value->>'status' = 'completed'),
    bool_or(
      entry.value->>'status' IN ('pending', 'in_progress')
      OR (
        entry.value->>'status' = 'failed'
        AND CASE
          WHEN COALESCE(entry.value->>'retry_count', '') ~ '^[0-9]{1,9}$'
            THEN (entry.value->>'retry_count')::integer
          ELSE 0
        END < 2
      )
    ),
    bool_or(entry.value->>'status' = 'failed'),
    bool_or(entry.value->>'status' IN ('cancelled', 'skipped'))
  INTO
    v_total, v_completed, v_has_runnable, v_has_failed, v_has_cancelled
  FROM jsonb_array_elements(v_steps) AS entry(value);

  v_next_status := 'in_progress';
  IF v_total > 0 AND v_completed = v_total THEN
    v_next_status := 'completed';
  ELSIF NOT COALESCE(v_has_runnable, false) AND COALESCE(v_has_failed, false) THEN
    v_next_status := 'failed';
  ELSIF NOT COALESCE(v_has_runnable, false) AND COALESCE(v_has_cancelled, false) THEN
    v_next_status := 'cancelled';
  END IF;

  UPDATE public.instance_plans
  SET
    status = v_next_status,
    steps_completed = v_completed,
    progress_percentage = CASE
      WHEN v_total = 0 THEN 0
      ELSE round((v_completed::numeric / v_total) * 100)::integer
    END,
    completed_at = CASE
      WHEN v_next_status = 'in_progress' THEN NULL
      ELSE COALESCE(completed_at, timezone('utc', now()))
    END,
    updated_at = timezone('utc', now())
  WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'state', 'applied',
    'status', v_next_status,
    'completed_count', v_completed,
    'total_count', v_total
  );
END;
$$;

DROP FUNCTION IF EXISTS public.block_requirement_for_product_no_progress(
  uuid, uuid, uuid, text, integer, text, integer
);
CREATE OR REPLACE FUNCTION public.block_requirement_for_product_no_progress(
  p_requirement_id uuid,
  p_site_id uuid,
  p_instance_id uuid,
  p_cycle_id text,
  p_minimum_failures integer,
  p_message text,
  p_expected_execution_generation integer,
  p_plan_id uuid,
  p_step_id text,
  p_expected_step_generation integer
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
  v_failure_cycles integer;
  v_execution_generation integer;
  v_steps jsonb;
  v_step jsonb;
  v_step_generation integer;
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

  v_execution_generation := CASE
    WHEN COALESCE(
      v_metadata->>'requirement_execution_generation', ''
    ) ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'requirement_execution_generation')::integer
    ELSE 0
  END;
  IF v_execution_generation IS DISTINCT FROM
    p_expected_execution_generation
  THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;

  SELECT
    CASE WHEN jsonb_typeof(steps) = 'array' THEN steps ELSE '[]'::jsonb END
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
  THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;
  v_step_generation := CASE
    WHEN COALESCE(v_step->>'infrastructure_generation', '') ~ '^[0-9]{1,9}$'
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
  ORDER BY cycle_started_at DESC, cycle_id DESC
  LIMIT 1;
  v_failure_cycles := CASE
    WHEN COALESCE(v_metadata->>'no_progress_cycles', '') ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'no_progress_cycles')::integer
    ELSE 0
  END;
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
      'cron_blocker_version', 1,
      'cron_blocker_event_id', p_cycle_id,
      'cron_blocker_plan_id', p_plan_id::text,
      'cron_blocker_step_id', p_step_id,
      'cron_blocker_generation', p_expected_step_generation
    ),
    updated_at = timezone('utc', now())
  WHERE id = p_requirement_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.requirement_status
    WHERE requirement_id = p_requirement_id AND cycle = v_audit_cycle
  ) THEN
    INSERT INTO public.requirement_status (
      requirement_id, site_id, instance_id, stage, cycle, message
    ) VALUES (
      p_requirement_id, p_site_id, p_instance_id,
      'blocked', v_audit_cycle, p_message
    );
  END IF;
  RETURN jsonb_build_object(
    'state', 'applied', 'blocked', true,
    'generation', v_step_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_instance_plan_step_after_gate(uuid, text, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_instance_plan_status_atomic(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_requirement_for_product_no_progress(uuid, uuid, uuid, text, integer, text, integer, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_instance_plan_step_after_gate(uuid, text, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_instance_plan_status_atomic(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.block_requirement_for_product_no_progress(uuid, uuid, uuid, text, integer, text, integer, uuid, text, integer) TO service_role;
