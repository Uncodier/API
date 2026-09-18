-- Rollback: drop the four block_requirement_* overloads declared below.
DROP FUNCTION IF EXISTS public.block_requirement_for_infrastructure_circuit(uuid, uuid, uuid, uuid, text, integer, text, text, text);
DROP FUNCTION IF EXISTS public.block_requirement_for_product_attempt_budget(uuid, uuid, uuid, text, integer, text);
CREATE OR REPLACE FUNCTION public.block_requirement_for_infrastructure_circuit(
  p_requirement_id uuid,
  p_site_id uuid,
  p_instance_id uuid,
  p_plan_id uuid,
  p_step_id text,
  p_expected_generation integer,
  p_provenance text,
  p_message text,
  p_event_id text,
  p_expected_execution_generation integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requirement_status text;
  v_requirement_site_id uuid;
  v_metadata jsonb;
  v_steps jsonb;
  v_step jsonb;
  v_generation integer;
  v_execution_generation integer;
  v_cycle text := 'infrastructure-circuit:' || p_event_id;
BEGIN
  IF p_provenance NOT IN (
    'cron_infrastructure',
    'deployment_infrastructure'
  ) THEN
    RAISE EXCEPTION 'Unsupported infrastructure blocker provenance: %',
      p_provenance;
  END IF;

  SELECT
    status,
    site_id,
    CASE
      WHEN jsonb_typeof(metadata) = 'object' THEN metadata
      ELSE '{}'::jsonb
    END
  INTO v_requirement_status, v_requirement_site_id, v_metadata
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'blocked', false);
  END IF;
  IF v_requirement_site_id IS DISTINCT FROM p_site_id THEN
    RAISE EXCEPTION 'Requirement % does not belong to site %',
      p_requirement_id,
      p_site_id;
  END IF;
  IF v_requirement_status IN ('done', 'cancelled', 'canceled', 'on-review')
    OR (
      v_requirement_status = 'blocked'
      AND v_metadata->>'cron_blocker_provenance' IN (
        'product_no_progress_circuit',
        'product_failure',
        'product_replan_circuit',
        'product_workflow_circuit'
      )
    )
  THEN
    RETURN jsonb_build_object('state', 'guarded', 'blocked', false);
  END IF;
  v_execution_generation := CASE
    WHEN COALESCE(
      v_metadata->>'requirement_execution_generation',
      ''
    ) ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'requirement_execution_generation')::integer
    ELSE 0
  END;
  IF v_execution_generation IS DISTINCT FROM p_expected_execution_generation THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;

  SELECT CASE
    WHEN jsonb_typeof(steps) = 'array' THEN steps
    ELSE '[]'::jsonb
  END
  INTO v_steps
  FROM public.instance_plans
  WHERE id = p_plan_id
    AND (
      metadata->>'requirement_id' = p_requirement_id::text
      OR (
        instance_id = p_instance_id
        AND metadata->>'requirement_id' IS NULL
      )
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'blocked', false);
  END IF;

  SELECT value
  INTO v_step
  FROM jsonb_array_elements(v_steps)
  WHERE value->>'id' = p_step_id
  LIMIT 1;
  IF v_step IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'blocked', false);
  END IF;

  v_generation := CASE
    WHEN COALESCE(v_step->>'infrastructure_generation', '') ~ '^[0-9]{1,9}$'
      THEN (v_step->>'infrastructure_generation')::integer
    ELSE 0
  END;
  IF v_generation IS DISTINCT FROM p_expected_generation
    OR COALESCE(v_step->>'infrastructure_circuit_open', '') <> 'true'
    OR v_step->>'infrastructure_failure_provenance' <> p_provenance
  THEN
    RETURN jsonb_build_object(
      'state', 'stale',
      'blocked', false,
      'generation', v_generation
    );
  END IF;

  UPDATE public.requirements
  SET
    status = 'blocked',
    metadata = v_metadata || jsonb_build_object(
      'cron_blocker_provenance', p_provenance,
      'cron_blocker_version', 1,
      'cron_blocker_event_id', p_event_id,
      'cron_blocker_plan_id', p_plan_id::text,
      'cron_blocker_step_id', p_step_id,
      'cron_blocker_generation', p_expected_generation
    ),
    updated_at = timezone('utc', now())
  WHERE id = p_requirement_id;

  IF NOT EXISTS (
    SELECT 1
    FROM public.requirement_status
    WHERE requirement_id = p_requirement_id
      AND cycle = v_cycle
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
      v_cycle,
      p_message
    );
  END IF;

  RETURN jsonb_build_object(
    'state', 'applied',
    'blocked', true,
    'generation', v_generation
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.block_requirement_for_cron_infrastructure_cycles(
  p_requirement_id uuid,
  p_site_id uuid,
  p_instance_id uuid,
  p_cycle_id text,
  p_minimum_failures integer,
  p_message text
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
  v_audit_cycle text := 'cron-infrastructure-circuit:' || p_cycle_id;
BEGIN
  IF p_minimum_failures IS NULL OR p_minimum_failures < 1 THEN
    RAISE EXCEPTION 'p_minimum_failures must be positive';
  END IF;
  SELECT
    status,
    site_id,
    CASE
      WHEN jsonb_typeof(metadata) = 'object' THEN metadata
      ELSE '{}'::jsonb
    END
  INTO v_status, v_site_id, v_metadata
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'blocked', false);
  END IF;
  IF v_site_id IS DISTINCT FROM p_site_id THEN
    RAISE EXCEPTION 'Requirement % does not belong to site %',
      p_requirement_id,
      p_site_id;
  END IF;
  IF v_status IN ('done', 'cancelled', 'canceled', 'on-review')
    OR (
      v_status = 'blocked'
      AND v_metadata->>'cron_blocker_provenance' IN (
        'product_no_progress_circuit',
        'product_failure',
        'product_replan_circuit',
        'product_workflow_circuit'
      )
    )
  THEN
    RETURN jsonb_build_object('state', 'guarded', 'blocked', false);
  END IF;

  SELECT cycle_id, outcome
  INTO v_latest_cycle_id, v_latest_outcome
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
  ORDER BY cycle_started_at DESC, cycle_id DESC
  LIMIT 1;
  v_failure_cycles := CASE
    WHEN COALESCE(
      v_metadata->>'cron_infrastructure_failure_cycles',
      ''
    ) ~ '^[0-9]{1,9}$'
      THEN (
        v_metadata->>'cron_infrastructure_failure_cycles'
      )::integer
    ELSE 0
  END;
  IF v_latest_cycle_id IS DISTINCT FROM p_cycle_id
    OR v_latest_outcome <> 'infrastructure_retry'
    OR v_failure_cycles < p_minimum_failures
  THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;

  UPDATE public.requirements
  SET
    status = 'blocked',
    metadata = v_metadata || jsonb_build_object(
      'cron_blocker_provenance', 'cron_infrastructure',
      'cron_blocker_version', 1,
      'cron_blocker_event_id', p_cycle_id
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

  RETURN jsonb_build_object('state', 'applied', 'blocked', true);
END;
$$;
CREATE OR REPLACE FUNCTION public.block_requirement_for_product_no_progress(
  p_requirement_id uuid,
  p_site_id uuid,
  p_instance_id uuid,
  p_cycle_id text,
  p_minimum_failures integer,
  p_message text
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
  v_audit_cycle text := 'product-no-progress-circuit:' || p_cycle_id;
BEGIN
  IF p_minimum_failures IS NULL OR p_minimum_failures < 1 THEN
    RAISE EXCEPTION 'p_minimum_failures must be positive';
  END IF;
  SELECT
    status,
    site_id,
    CASE
      WHEN jsonb_typeof(metadata) = 'object' THEN metadata
      ELSE '{}'::jsonb
    END
  INTO v_status, v_site_id, v_metadata
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'blocked', false);
  END IF;
  IF v_site_id IS DISTINCT FROM p_site_id THEN
    RAISE EXCEPTION 'Requirement % does not belong to site %',
      p_requirement_id,
      p_site_id;
  END IF;
  IF v_status IN ('done', 'cancelled', 'canceled', 'on-review') THEN
    RETURN jsonb_build_object('state', 'guarded', 'blocked', false);
  END IF;

  SELECT cycle_id, outcome
  INTO v_latest_cycle_id, v_latest_outcome
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
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
      'cron_blocker_event_id', p_cycle_id
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
      requirement_id, site_id, instance_id, stage, cycle, message
    )
    VALUES (
      p_requirement_id, p_site_id, p_instance_id,
      'blocked', v_audit_cycle, p_message
    );
  END IF;

  RETURN jsonb_build_object('state', 'applied', 'blocked', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.block_requirement_for_product_attempt_budget(
  p_requirement_id uuid,
  p_site_id uuid,
  p_instance_id uuid,
  p_cycle_id text,
  p_max_attempts integer,
  p_message text,
  p_expected_execution_generation integer
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
  v_attempts integer;
  v_execution_generation integer;
  v_audit_cycle text := 'product-attempt-circuit:' || p_cycle_id;
BEGIN
  IF p_max_attempts IS NULL OR p_max_attempts < 1 THEN
    RAISE EXCEPTION 'p_max_attempts must be positive';
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
      v_metadata->>'requirement_execution_generation',
      ''
    ) ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'requirement_execution_generation')::integer
    ELSE 0
  END;
  IF v_execution_generation IS DISTINCT FROM p_expected_execution_generation THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;

  SELECT cycle_id, outcome
  INTO v_latest_cycle_id, v_latest_outcome
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
    AND execution_generation = p_expected_execution_generation
  ORDER BY cycle_started_at DESC, cycle_id DESC
  LIMIT 1;
  v_attempts := CASE
    WHEN COALESCE(v_metadata->>'cron_attempts', '') ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'cron_attempts')::integer
    ELSE 0
  END;
  IF v_latest_cycle_id IS DISTINCT FROM p_cycle_id
    OR v_latest_outcome NOT IN ('product_no_progress', 'product_failure')
    OR v_attempts < p_max_attempts
  THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;

  UPDATE public.requirements
  SET
    status = 'blocked',
    metadata = v_metadata || jsonb_build_object(
      'cron_blocker_provenance', 'product_no_progress_circuit',
      'cron_blocker_version', 1,
      'cron_blocker_event_id', p_cycle_id
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
  RETURN jsonb_build_object('state', 'applied', 'blocked', true);
END;
$$;

REVOKE ALL ON FUNCTION public.block_requirement_for_infrastructure_circuit(uuid, uuid, uuid, uuid, text, integer, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_requirement_for_cron_infrastructure_cycles(uuid, uuid, uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_requirement_for_product_no_progress(uuid, uuid, uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_requirement_for_product_attempt_budget(uuid, uuid, uuid, text, integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.block_requirement_for_infrastructure_circuit(uuid, uuid, uuid, uuid, text, integer, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.block_requirement_for_cron_infrastructure_cycles(uuid, uuid, uuid, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.block_requirement_for_product_no_progress(uuid, uuid, uuid, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.block_requirement_for_product_attempt_budget(uuid, uuid, uuid, text, integer, text, integer) TO service_role;
