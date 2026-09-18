-- Rollback:
-- DROP FUNCTION IF EXISTS public.block_requirement_with_provenance(uuid, uuid, uuid, text, text, text, integer);

DROP FUNCTION IF EXISTS public.block_requirement_with_provenance(
  uuid, uuid, uuid, text, text, text
);

CREATE OR REPLACE FUNCTION public.block_requirement_with_provenance(
  p_requirement_id uuid,
  p_site_id uuid,
  p_instance_id uuid,
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
  v_status text;
  v_site_id uuid;
  v_metadata jsonb;
  v_execution_generation integer;
  v_cycle text := 'requirement-block:' || p_event_id;
BEGIN
  IF NULLIF(btrim(p_event_id), '') IS NULL THEN
    RAISE EXCEPTION 'Block event id is required';
  END IF;
  IF p_provenance NOT IN (
    'product_failure',
    'product_no_progress_circuit',
    'product_replan_circuit',
    'product_workflow_circuit'
  ) THEN
    RAISE EXCEPTION 'Unsupported product blocker provenance: %', p_provenance;
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

  UPDATE public.requirements
  SET
    status = 'blocked',
    metadata = v_metadata || jsonb_build_object(
      'cron_blocker_provenance', p_provenance,
      'cron_blocker_version', 1,
      'cron_blocker_event_id', p_event_id
    ),
    updated_at = timezone('utc', now())
  WHERE id = p_requirement_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.requirement_status
    WHERE requirement_id = p_requirement_id AND cycle = v_cycle
  ) THEN
    INSERT INTO public.requirement_status (
      requirement_id, site_id, instance_id, stage, cycle, message
    ) VALUES (
      p_requirement_id, p_site_id, p_instance_id,
      'blocked', v_cycle, p_message
    );
  END IF;
  RETURN jsonb_build_object('state', 'applied', 'blocked', true);
END;
$$;

REVOKE ALL ON FUNCTION public.block_requirement_with_provenance(uuid, uuid, uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.block_requirement_with_provenance(uuid, uuid, uuid, text, text, text, integer) TO service_role;
