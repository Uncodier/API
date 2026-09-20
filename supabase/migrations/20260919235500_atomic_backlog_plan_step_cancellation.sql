-- Rollback:
-- DROP FUNCTION IF EXISTS public.cancel_requirement_plan_steps_for_backlog_items(
--   uuid, text[], text, uuid
-- );

CREATE OR REPLACE FUNCTION public.cancel_requirement_plan_steps_for_backlog_items(
  p_requirement_id uuid,
  p_item_ids text[],
  p_reason text,
  p_instance_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item_ids text[];
  v_plan record;
  v_next_steps jsonb;
  v_steps_cancelled integer;
  v_total_steps_cancelled integer := 0;
  v_plans_touched integer := 0;
  v_plans_cancelled integer := 0;
  v_plan_ids uuid[] := ARRAY[]::uuid[];
  v_still_runnable boolean;
  v_now timestamptz := timezone('utc', now());
  v_mutation_at timestamptz;
BEGIN
  IF p_requirement_id IS NULL THEN
    RAISE EXCEPTION 'p_requirement_id is required';
  END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'p_reason is required';
  END IF;

  SELECT array_agg(DISTINCT btrim(item_id))
  INTO v_item_ids
  FROM unnest(COALESCE(p_item_ids, ARRAY[]::text[])) AS item(item_id)
  WHERE NULLIF(btrim(item_id), '') IS NOT NULL;

  IF COALESCE(cardinality(v_item_ids), 0) = 0 THEN
    RETURN jsonb_build_object(
      'plans_touched', 0,
      'plans_cancelled', 0,
      'steps_cancelled', 0,
      'plan_ids', '[]'::jsonb,
      'errors', '[]'::jsonb
    );
  END IF;

  FOR v_plan IN
    SELECT id, status, steps, updated_at, completion_reason, completed_at
    FROM public.instance_plans
    WHERE metadata->>'requirement_id' = p_requirement_id::text
      AND status IN ('pending', 'in_progress', 'active', 'paused')
      AND (p_instance_id IS NULL OR instance_id = p_instance_id)
    ORDER BY id
    FOR UPDATE
  LOOP
    v_mutation_at := GREATEST(
      v_now,
      COALESCE(v_plan.updated_at + interval '1 millisecond', v_now)
    );

    SELECT
      COALESCE(jsonb_agg(
        CASE
          WHEN COALESCE(
            step.value->'metadata'->>'backlog_item_id',
            step.value->>'backlog_item_id'
          ) = ANY(v_item_ids)
            AND step.value->>'status' IN (
              'pending', 'in_progress', 'failed'
            )
          THEN step.value || jsonb_build_object(
            'status', 'cancelled',
            'cancellation_reason', left(p_reason, 240),
            'cancelled_at', v_mutation_at
          )
          ELSE step.value
        END
        ORDER BY step.ordinality
      ), '[]'::jsonb),
      count(*) FILTER (
        WHERE COALESCE(
          step.value->'metadata'->>'backlog_item_id',
          step.value->>'backlog_item_id'
        ) = ANY(v_item_ids)
          AND step.value->>'status' IN (
            'pending', 'in_progress', 'failed'
          )
      )::integer
    INTO v_next_steps, v_steps_cancelled
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(v_plan.steps) = 'array'
        THEN v_plan.steps ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS step(value, ordinality);

    IF v_steps_cancelled = 0 THEN
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_steps) AS step(value)
      WHERE step.value->>'status' NOT IN (
        'completed', 'cancelled', 'skipped', 'paused'
      )
        AND (
          step.value->>'status' <> 'failed'
          OR CASE
            WHEN COALESCE(step.value->>'retry_count', '') ~ '^[0-9]{1,9}$'
              THEN (step.value->>'retry_count')::integer
            ELSE 0
          END < 2
        )
      )
    INTO v_still_runnable;

    UPDATE public.instance_plans
    SET
      steps = v_next_steps,
      status = CASE
        WHEN v_still_runnable THEN v_plan.status
        ELSE 'cancelled'
      END,
      completion_reason = CASE
        WHEN v_still_runnable THEN v_plan.completion_reason
        ELSE left(
          'Backlog item cancellation reached terminal state — ' || p_reason,
          500
        )
      END,
      completed_at = CASE
        WHEN v_still_runnable THEN v_plan.completed_at
        ELSE COALESCE(v_plan.completed_at, v_mutation_at)
      END,
      updated_at = v_mutation_at
    WHERE id = v_plan.id;

    v_plans_touched := v_plans_touched + 1;
    v_total_steps_cancelled :=
      v_total_steps_cancelled + v_steps_cancelled;
    v_plan_ids := array_append(v_plan_ids, v_plan.id);
    IF NOT v_still_runnable THEN
      v_plans_cancelled := v_plans_cancelled + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'plans_touched', v_plans_touched,
    'plans_cancelled', v_plans_cancelled,
    'steps_cancelled', v_total_steps_cancelled,
    'plan_ids', to_jsonb(v_plan_ids),
    'errors', '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_requirement_plan_steps_for_backlog_items(
  uuid, text[], text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_requirement_plan_steps_for_backlog_items(
  uuid, text[], text, uuid
) TO service_role;
