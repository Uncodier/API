-- Rollback:
-- DROP FUNCTION IF EXISTS public.patch_instance_plan_step_atomic(uuid, text, integer, text, jsonb);

CREATE OR REPLACE FUNCTION public.patch_instance_plan_step_atomic(
  p_plan_id uuid,
  p_step_id text,
  p_expected_generation integer,
  p_event_id text,
  p_patch jsonb
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
  v_generation integer;
  v_event_generation integer;
  v_next_status text;
  v_safe_patch jsonb;
BEGIN
  IF NULLIF(btrim(p_event_id), '') IS NULL
    OR jsonb_typeof(p_patch) <> 'object'
  THEN
    RAISE EXCEPTION 'Event id and object patch are required';
  END IF;

  SELECT CASE WHEN jsonb_typeof(steps) = 'array'
    THEN steps ELSE '[]'::jsonb END
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
  SELECT CASE
    WHEN COALESCE(details->>'generation', '') ~ '^[0-9]{1,9}$'
      THEN (details->>'generation')::integer
    ELSE 0
  END
  INTO v_event_generation
  FROM public.instance_plan_step_infrastructure_events
  WHERE plan_id = p_plan_id
    AND step_id = p_step_id
    AND event_id = p_event_id;
  IF FOUND THEN
    IF v_event_generation IS NOT DISTINCT FROM v_generation
      AND v_event_generation::bigint IS NOT DISTINCT FROM
        p_expected_generation::bigint + 1
    THEN
      RETURN jsonb_build_object(
        'state', 'duplicate', 'persisted', true,
        'generation', v_event_generation
      );
    END IF;
    RETURN jsonb_build_object(
      'state', 'stale', 'persisted', false, 'generation', v_generation
    );
  END IF;
  IF v_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object(
      'state', 'stale', 'persisted', false, 'generation', v_generation
    );
  END IF;

  v_next_status := p_patch->>'status';
  IF v_step->>'status' IN ('completed', 'cancelled')
    AND COALESCE(v_next_status, v_step->>'status') <> v_step->>'status'
  THEN
    RETURN jsonb_build_object(
      'state', 'terminal', 'persisted', false, 'generation', v_generation
    );
  END IF;

  v_safe_patch := p_patch
    - ARRAY['id', 'order', 'infrastructure_generation'];
  v_step := v_step || v_safe_patch || jsonb_build_object(
    'infrastructure_generation', v_generation + 1,
    'infrastructure_last_event_id', p_event_id
  );
  v_steps := jsonb_set(
    v_steps, ARRAY[v_step_index::text], v_step, false
  );
  UPDATE public.instance_plans
  SET steps = v_steps, updated_at = timezone('utc', now())
  WHERE id = p_plan_id;

  INSERT INTO public.instance_plan_step_infrastructure_events (
    plan_id, step_id, event_id, event_type, details
  ) VALUES (
    p_plan_id, p_step_id, p_event_id, 'step_patch',
    jsonb_build_object('generation', v_generation + 1)
  );
  RETURN jsonb_build_object(
    'state', 'applied', 'persisted', true,
    'generation', v_generation + 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.patch_instance_plan_step_atomic(uuid, text, integer, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patch_instance_plan_step_atomic(uuid, text, integer, text, jsonb) TO service_role;
