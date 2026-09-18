-- Rollback:
-- DROP FUNCTION IF EXISTS public.finalize_requirement_execution_atomic(uuid, uuid, uuid, integer, text, uuid, text, text, text, text, text, text, boolean, boolean);

CREATE OR REPLACE FUNCTION public.finalize_requirement_execution_atomic(
  p_requirement_id uuid,
  p_site_id uuid,
  p_instance_id uuid,
  p_expected_execution_generation integer,
  p_event_id text,
  p_existing_status_id uuid,
  p_stage text,
  p_message text,
  p_repo_url text,
  p_preview_url text,
  p_source_code text,
  p_snapshot_id text,
  p_is_complete boolean,
  p_mark_on_review boolean
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
  v_backlog jsonb;
  v_execution_generation integer;
  v_status_id uuid;
  v_cycle text := 'cron-finalize:' || p_event_id;
  v_has_outstanding_work boolean := false;
BEGIN
  IF NULLIF(btrim(p_event_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_event_id is required';
  END IF;
  IF p_stage NOT IN ('done', 'in-progress', 'blocked', 'on-review') THEN
    RAISE EXCEPTION 'Unsupported final requirement status: %', p_stage;
  END IF;

  SELECT
    status,
    site_id,
    CASE WHEN jsonb_typeof(metadata) = 'object'
      THEN metadata ELSE '{}'::jsonb END,
    CASE WHEN jsonb_typeof(backlog) = 'object'
      THEN backlog ELSE '{}'::jsonb END
  INTO
    v_requirement_status,
    v_requirement_site_id,
    v_metadata,
    v_backlog
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'state', 'missing',
      'effective_status', 'in-progress'
    );
  END IF;
  IF v_requirement_site_id IS DISTINCT FROM p_site_id THEN
    RAISE EXCEPTION 'Requirement % does not belong to site %',
      p_requirement_id, p_site_id;
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
    RETURN jsonb_build_object(
      'state', 'stale',
      'effective_status', 'in-progress'
    );
  END IF;
  IF v_requirement_status IN ('cancelled', 'canceled')
    OR (v_requirement_status = 'done' AND NOT p_is_complete)
  THEN
    RETURN jsonb_build_object(
      'state', 'guarded',
      'effective_status',
      CASE WHEN v_requirement_status = 'done' THEN 'done' ELSE 'blocked' END
    );
  END IF;

  SELECT id
  INTO v_status_id
  FROM public.requirement_status
  WHERE requirement_id = p_requirement_id
    AND cycle = v_cycle
  ORDER BY created_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;

  IF v_status_id IS NULL AND p_existing_status_id IS NOT NULL THEN
    SELECT id
    INTO v_status_id
    FROM public.requirement_status
    WHERE id = p_existing_status_id
      AND requirement_id = p_requirement_id
      AND site_id = p_site_id
      AND instance_id IS NOT DISTINCT FROM p_instance_id
    FOR UPDATE;
  END IF;

  IF v_status_id IS NULL THEN
    INSERT INTO public.requirement_status (
      site_id,
      instance_id,
      requirement_id,
      repo_url,
      preview_url,
      source_code,
      snapshot_id,
      stage,
      cycle,
      message
    ) VALUES (
      p_site_id,
      p_instance_id,
      p_requirement_id,
      p_repo_url,
      p_preview_url,
      p_source_code,
      p_snapshot_id,
      p_stage,
      v_cycle,
      p_message
    )
    RETURNING id INTO v_status_id;
  ELSE
    UPDATE public.requirement_status
    SET
      repo_url = p_repo_url,
      preview_url = p_preview_url,
      source_code = p_source_code,
      snapshot_id = COALESCE(p_snapshot_id, snapshot_id),
      stage = p_stage,
      cycle = v_cycle,
      message = p_message,
      updated_at = timezone('utc', now())
    WHERE id = v_status_id;
  END IF;

  IF p_is_complete THEN
    UPDATE public.requirements
    SET status = 'done', updated_at = timezone('utc', now())
    WHERE id = p_requirement_id;

    UPDATE public.remote_instances
    SET status = 'pending'
    WHERE id = p_instance_id
      AND site_id = p_site_id
      AND status IN ('running', 'starting');

    UPDATE public.instance_plans
    SET status = 'cancelled', updated_at = timezone('utc', now())
    WHERE instance_id = p_instance_id
      AND metadata->>'requirement_id' = p_requirement_id::text
      AND status IN ('pending', 'in_progress', 'active');
  ELSIF p_mark_on_review THEN
    SELECT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(v_backlog->'items') = 'array'
            THEN v_backlog->'items'
          ELSE '[]'::jsonb
        END
      ) AS item
      WHERE COALESCE(item->>'status', '') NOT IN (
        'done',
        'needs_review',
        'rejected'
      )
    )
    INTO v_has_outstanding_work;
    IF NOT v_has_outstanding_work THEN
      UPDATE public.requirements
      SET status = 'on-review', updated_at = timezone('utc', now())
      WHERE id = p_requirement_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'state', 'applied',
    'effective_status', p_stage,
    'status_id', v_status_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_requirement_execution_atomic(uuid, uuid, uuid, integer, text, uuid, text, text, text, text, text, text, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_requirement_execution_atomic(uuid, uuid, uuid, integer, text, uuid, text, text, text, text, text, text, boolean, boolean) TO service_role;
