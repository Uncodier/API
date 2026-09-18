-- Rollback:
-- DROP FUNCTION IF EXISTS public.block_requirement_for_cron_infrastructure_cycles(uuid, uuid, uuid, text, integer, text, integer);
-- DROP FUNCTION IF EXISTS public.block_requirement_for_product_no_progress(uuid, uuid, uuid, text, integer, text, integer);

-- PostgreSQL keeps the old entry point when a parameter is added.
DROP FUNCTION IF EXISTS public.block_requirement_for_cron_infrastructure_cycles(
  uuid, uuid, uuid, text, integer, text
);
DROP FUNCTION IF EXISTS public.block_requirement_for_product_no_progress(
  uuid, uuid, uuid, text, integer, text
);

CREATE OR REPLACE FUNCTION public.block_requirement_for_cron_infrastructure_cycles(
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
  v_status text;
  v_site_id uuid;
  v_metadata jsonb;
  v_latest_cycle_id text;
  v_latest_outcome text;
  v_failure_cycles integer;
  v_execution_generation integer;
  v_audit_cycle text := 'cron-infrastructure-circuit:' || p_cycle_id;
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

  v_execution_generation := CASE
    WHEN COALESCE(
      v_metadata->>'requirement_execution_generation',
      ''
    ) ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'requirement_execution_generation')::integer
    ELSE 0
  END;
  IF v_execution_generation IS DISTINCT FROM
    p_expected_execution_generation
  THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
  END IF;

  SELECT cycle_id, outcome
  INTO v_latest_cycle_id, v_latest_outcome
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
    AND execution_generation = p_expected_execution_generation
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
    SELECT 1 FROM public.requirement_status
    WHERE requirement_id = p_requirement_id
      AND cycle = v_audit_cycle
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
  v_status text;
  v_site_id uuid;
  v_metadata jsonb;
  v_latest_cycle_id text;
  v_latest_outcome text;
  v_failure_cycles integer;
  v_execution_generation integer;
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
      v_metadata->>'requirement_execution_generation',
      ''
    ) ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'requirement_execution_generation')::integer
    ELSE 0
  END;
  IF v_execution_generation IS DISTINCT FROM
    p_expected_execution_generation
  THEN
    RETURN jsonb_build_object('state', 'stale', 'blocked', false);
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
      'cron_blocker_event_id', p_cycle_id
    ),
    updated_at = timezone('utc', now())
  WHERE id = p_requirement_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.requirement_status
    WHERE requirement_id = p_requirement_id
      AND cycle = v_audit_cycle
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

REVOKE ALL ON FUNCTION public.block_requirement_for_cron_infrastructure_cycles(uuid, uuid, uuid, text, integer, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_requirement_for_product_no_progress(uuid, uuid, uuid, text, integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.block_requirement_for_cron_infrastructure_cycles(uuid, uuid, uuid, text, integer, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.block_requirement_for_product_no_progress(uuid, uuid, uuid, text, integer, text, integer) TO service_role;
