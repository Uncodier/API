CREATE OR REPLACE FUNCTION public.append_instance_plan_repair_step_atomic(
  p_plan_id uuid,
  p_source_step_id text,
  p_expected_source_generation integer,
  p_repair_run_id text,
  p_repair_step jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan public.instance_plans%ROWTYPE;
  v_steps jsonb;
  v_source_step jsonb;
  v_source_generation integer;
  v_step jsonb;
BEGIN
  SELECT * INTO v_plan
  FROM public.instance_plans
  WHERE id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'persisted', false);
  END IF;

  v_steps := COALESCE(v_plan.steps, '[]'::jsonb);
  SELECT step INTO v_source_step
  FROM jsonb_array_elements(v_steps) AS step
  WHERE step->>'id' = p_source_step_id
  LIMIT 1;

  IF v_source_step IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'persisted', false);
  END IF;

  IF v_source_step->>'status' IS DISTINCT FROM 'completed' THEN
    RETURN jsonb_build_object('state', 'stale', 'persisted', false);
  END IF;

  SELECT step INTO v_step
  FROM jsonb_array_elements(v_steps) AS step
  WHERE step->'metadata'->>'repair_source_step_id' = p_source_step_id
    AND step->'metadata'->'repair_run'->>'repair_run_id' = p_repair_run_id
  LIMIT 1;
  IF v_step IS NOT NULL THEN
    RETURN jsonb_build_object(
      'state', 'duplicate',
      'persisted', true,
      'step_id', v_step->>'id',
      'generation', CASE
        WHEN COALESCE(v_step->>'infrastructure_generation', '') ~ '^[0-9]{1,9}$'
          THEN (v_step->>'infrastructure_generation')::integer
        ELSE 0
      END
    );
  END IF;

  v_source_generation := CASE
    WHEN COALESCE(v_source_step->>'infrastructure_generation', '') ~ '^[0-9]{1,9}$'
      THEN (v_source_step->>'infrastructure_generation')::integer
    ELSE 0
  END;
  IF v_source_generation IS DISTINCT FROM p_expected_source_generation THEN
    RETURN jsonb_build_object(
      'state', 'stale',
      'persisted', false,
      'generation', v_source_generation
    );
  END IF;

  IF v_plan.status NOT IN ('completed', 'in_progress') THEN
    RETURN jsonb_build_object(
      'state', 'stale',
      'persisted', false,
      'generation', v_source_generation
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_steps) AS step
    WHERE step->>'id' = p_repair_step->>'id'
  ) THEN
    RETURN jsonb_build_object(
      'state', 'stale',
      'persisted', false,
      'generation', v_source_generation
    );
  END IF;

  IF p_repair_step->'metadata'->'repair_run'->>'repair_run_id'
    IS DISTINCT FROM p_repair_run_id
  THEN
    RAISE EXCEPTION 'repair step identity does not match repair run id';
  END IF;

  v_step := p_repair_step || jsonb_build_object(
    'status', 'pending',
    'infrastructure_generation', 0,
    'created_at', COALESCE(p_repair_step->>'created_at', timezone('utc', now())::text),
    'updated_at', timezone('utc', now())::text
  );
  v_steps := v_steps || jsonb_build_array(v_step);

  UPDATE public.instance_plans
  SET
    steps = v_steps,
    status = 'in_progress',
    completed_at = NULL,
    steps_total = jsonb_array_length(v_steps),
    progress_percentage = CASE
      WHEN jsonb_array_length(v_steps) = 0 THEN 0
      ELSE round(
        100.0 * (
          SELECT count(*) FROM jsonb_array_elements(v_steps) AS step
          WHERE step->>'status' = 'completed'
        ) / jsonb_array_length(v_steps)
      )
    END,
    updated_at = timezone('utc', now())
  WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'state', 'applied',
    'persisted', true,
    'step_id', v_step->>'id',
    'generation', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.append_instance_plan_repair_step_atomic(
  uuid, text, integer, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_instance_plan_repair_step_atomic(
  uuid, text, integer, text, jsonb
) TO service_role;