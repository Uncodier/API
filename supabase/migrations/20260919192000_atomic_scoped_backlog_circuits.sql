-- Rollback: DROP FUNCTION IF EXISTS public.block_backlog_item_for_circuit_atomic(
--   uuid, uuid, uuid, uuid, text, text, integer, integer, text, text, text,
--   text, text, timestamptz, text, text, integer, integer, integer
-- );

CREATE OR REPLACE FUNCTION public.block_backlog_item_for_circuit_atomic(
  p_requirement_id uuid,
  p_site_id uuid,
  p_instance_id uuid,
  p_plan_id uuid,
  p_step_id text,
  p_backlog_item_id text,
  p_expected_step_generation integer,
  p_expected_execution_generation integer,
  p_circuit_kind text,
  p_blocker_id text,
  p_category text,
  p_reason text,
  p_resolution_actor text,
  p_retry_after timestamptz,
  p_provenance text,
  p_cycle_id text,
  p_minimum_failures integer,
  p_core_attempt_limit integer,
  p_ornamental_attempt_limit integer
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
  v_backlog jsonb;
  v_items jsonb;
  v_steps jsonb;
  v_step jsonb;
  v_generation integer;
  v_latest_cycle_id text;
  v_latest_outcome text;
  v_last_progress_at timestamptz;
  v_last_progress_cycle_id text;
  v_failures integer := 0;
  v_affected text[];
  v_blocker jsonb;
  v_next_items jsonb;
  v_has_alternative boolean := false;
  v_now timestamptz := timezone('utc', now());
  v_plan record;
  v_next_steps jsonb;
  v_plan_runnable boolean;
BEGIN
  IF p_circuit_kind NOT IN ('infrastructure', 'product_no_progress') THEN
    RAISE EXCEPTION 'Unsupported scoped circuit kind: %', p_circuit_kind;
  END IF;
  IF p_circuit_kind = 'product_no_progress'
    AND (p_minimum_failures IS NULL OR p_minimum_failures < 1)
  THEN
    RAISE EXCEPTION 'p_minimum_failures must be positive';
  END IF;
  IF p_core_attempt_limit < 1 OR p_ornamental_attempt_limit < 1 THEN
    RAISE EXCEPTION 'Attempt limits must be positive';
  END IF;

  SELECT status, site_id,
    CASE WHEN jsonb_typeof(metadata) = 'object'
      THEN metadata ELSE '{}'::jsonb END,
    CASE WHEN jsonb_typeof(backlog) = 'object'
      THEN backlog ELSE '{}'::jsonb END
  INTO v_status, v_site_id, v_metadata, v_backlog
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'state', 'missing', 'isolated', false,
      'affected_item_ids', '[]'::jsonb
    );
  END IF;
  IF v_site_id IS DISTINCT FROM p_site_id THEN
    RAISE EXCEPTION 'Requirement % does not belong to site %',
      p_requirement_id, p_site_id;
  END IF;
  IF v_status IN (
    'done', 'cancelled', 'canceled', 'on-review', 'blocked'
  ) THEN
    RETURN jsonb_build_object(
      'state', 'guarded', 'isolated', false,
      'affected_item_ids', '[]'::jsonb
    );
  END IF;
  IF (
    CASE WHEN COALESCE(
      v_metadata->>'requirement_execution_generation', ''
    ) ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'requirement_execution_generation')::integer
      ELSE 0
    END
  ) IS DISTINCT FROM p_expected_execution_generation THEN
    RETURN jsonb_build_object(
      'state', 'stale', 'isolated', false,
      'affected_item_ids', '[]'::jsonb
    );
  END IF;

  v_items := CASE WHEN jsonb_typeof(v_backlog->'items') = 'array'
    THEN v_backlog->'items' ELSE '[]'::jsonb END;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_items) AS item(value)
    WHERE item.value->>'id' = p_backlog_item_id
      AND item.value->>'status' IN ('pending', 'in_progress')
  ) THEN
    RETURN jsonb_build_object(
      'state', 'stale', 'isolated', false,
      'affected_item_ids', '[]'::jsonb
    );
  END IF;

  SELECT CASE WHEN jsonb_typeof(steps) = 'array'
    THEN steps ELSE '[]'::jsonb END
  INTO v_steps
  FROM public.instance_plans
  WHERE id = p_plan_id
    AND instance_id = p_instance_id
    AND metadata->>'requirement_id' = p_requirement_id::text
    AND status IN ('pending', 'in_progress', 'active')
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'state', 'stale', 'isolated', false,
      'affected_item_ids', '[]'::jsonb
    );
  END IF;
  SELECT entry.value INTO v_step
  FROM jsonb_array_elements(v_steps) AS entry(value)
  WHERE entry.value->>'id' = p_step_id
  LIMIT 1;
  v_generation := CASE WHEN COALESCE(
    v_step->>'infrastructure_generation', ''
  ) ~ '^[0-9]{1,9}$'
    THEN (v_step->>'infrastructure_generation')::integer ELSE 0 END;
  IF v_step IS NULL
    OR COALESCE(
      v_step->'metadata'->>'backlog_item_id',
      v_step->>'backlog_item_id'
    ) IS DISTINCT FROM p_backlog_item_id
    OR v_step->>'status' NOT IN ('pending', 'in_progress', 'failed')
    OR v_generation IS DISTINCT FROM p_expected_step_generation
  THEN
    RETURN jsonb_build_object(
      'state', 'stale', 'isolated', false,
      'affected_item_ids', '[]'::jsonb,
      'generation', v_generation
    );
  END IF;

  IF p_circuit_kind = 'infrastructure' THEN
    IF COALESCE(v_step->>'infrastructure_circuit_open', '') <> 'true'
      OR v_step->>'infrastructure_failure_provenance'
        IS DISTINCT FROM p_provenance
    THEN
      RETURN jsonb_build_object(
        'state', 'stale', 'isolated', false,
        'affected_item_ids', '[]'::jsonb,
        'generation', v_generation
      );
    END IF;
  ELSE
    IF COALESCE(
      v_step->'metadata'->'no_progress_adjudication'->>'state', ''
    ) <> 'consumed'
      OR COALESCE(
        v_step->'metadata'->'no_progress_adjudication'
          ->>'execution_generation', ''
      ) <> p_expected_execution_generation::text
    THEN
      RETURN jsonb_build_object(
        'state', 'stale', 'isolated', false,
        'affected_item_ids', '[]'::jsonb,
        'generation', v_generation
      );
    END IF;
    SELECT cycle_id, outcome
    INTO v_latest_cycle_id, v_latest_outcome
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND plan_id = p_plan_id
      AND step_id = p_step_id
    ORDER BY cycle_started_at DESC, cycle_id DESC
    LIMIT 1;
    SELECT cycle_started_at, cycle_id
    INTO v_last_progress_at, v_last_progress_cycle_id
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND plan_id = p_plan_id
      AND step_id = p_step_id
      AND outcome = 'progress'
    ORDER BY cycle_started_at DESC, cycle_id DESC
    LIMIT 1;
    SELECT count(*)::integer INTO v_failures
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND plan_id = p_plan_id
      AND step_id = p_step_id
      AND outcome = 'product_no_progress'
      AND (
        v_last_progress_at IS NULL
        OR (cycle_started_at, cycle_id) >
          (v_last_progress_at, v_last_progress_cycle_id)
      );
    IF v_latest_cycle_id IS DISTINCT FROM p_cycle_id
      OR v_latest_outcome <> 'product_no_progress'
      OR v_failures < p_minimum_failures
    THEN
      RETURN jsonb_build_object(
        'state', 'stale', 'isolated', false,
        'affected_item_ids', '[]'::jsonb,
        'generation', v_generation
      );
    END IF;
  END IF;

  WITH RECURSIVE affected(item_id) AS (
    SELECT p_backlog_item_id
    UNION
    SELECT child.value->>'id'
    FROM jsonb_array_elements(v_items) AS child(value)
    JOIN affected parent ON EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(child.value->'depends_on') = 'array'
          THEN child.value->'depends_on' ELSE '[]'::jsonb END
      ) AS dependency(value)
      WHERE dependency.value = parent.item_id
    )
  )
  SELECT array_agg(item_id) INTO v_affected FROM affected;

  v_blocker := jsonb_strip_nulls(jsonb_build_object(
    'blocker_id', p_blocker_id,
    'category', p_category,
    'reason', p_reason,
    'resolution_actor', p_resolution_actor,
    'source_item_id', p_backlog_item_id,
    'source_step_id', p_step_id,
    'user_action_required', false,
    'retry_after', p_retry_after,
    'created_at', v_now
  ));
  SELECT jsonb_agg(
    CASE
      WHEN item.value->>'id' = ANY(v_affected) THEN
        item.value ||
        CASE WHEN item.value->>'id' = p_backlog_item_id
          THEN jsonb_build_object('status', 'pending', 'updated_at', v_now)
          ELSE '{}'::jsonb END ||
        jsonb_build_object(
          'blocked_by',
          COALESCE((
            SELECT jsonb_agg(existing.value)
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(item.value->'blocked_by') = 'array'
                THEN item.value->'blocked_by' ELSE '[]'::jsonb END
            ) AS existing(value)
            WHERE existing.value->>'blocker_id' <> p_blocker_id
          ), '[]'::jsonb) ||
          jsonb_build_array(
            CASE WHEN item.value->>'id' = p_backlog_item_id
              THEN v_blocker
              ELSE v_blocker || jsonb_build_object(
                'propagated_from_item_id', p_backlog_item_id
              )
            END
          )
        )
      ELSE item.value
    END
    ORDER BY item.ordinality
  ) INTO v_next_items
  FROM jsonb_array_elements(v_items) WITH ORDINALITY AS item(value, ordinality);

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_next_items) AS candidate(value)
    WHERE candidate.value->>'id' <> ALL(v_affected)
      AND candidate.value->>'status' IN ('pending', 'in_progress')
      AND jsonb_array_length(
        CASE WHEN jsonb_typeof(candidate.value->'blocked_by') = 'array'
          THEN candidate.value->'blocked_by' ELSE '[]'::jsonb END
      ) = 0
      AND CASE WHEN candidate.value->>'tier' = 'ornamental'
        THEN (
          CASE WHEN COALESCE(candidate.value->>'attempts', '') ~ '^[0-9]+$'
            THEN (candidate.value->>'attempts')::integer ELSE 0 END
        ) < p_ornamental_attempt_limit
        ELSE (
          CASE WHEN COALESCE(candidate.value->>'attempts', '') ~ '^[0-9]+$'
            THEN (candidate.value->>'attempts')::integer ELSE 0 END
        ) < p_core_attempt_limit
      END
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(candidate.value->'depends_on') = 'array'
            THEN candidate.value->'depends_on' ELSE '[]'::jsonb END
        ) AS dependency(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_next_items) AS completed(value)
          WHERE completed.value->>'id' = dependency.value
            AND completed.value->>'status' = 'done'
        )
      )
  ) INTO v_has_alternative;
  IF NOT v_has_alternative THEN
    RETURN jsonb_build_object(
      'state', 'no_alternative', 'isolated', false,
      'affected_item_ids', to_jsonb(v_affected),
      'generation', v_generation
    );
  END IF;

  UPDATE public.requirements
  SET backlog = jsonb_set(v_backlog, '{items}', v_next_items),
      backlog_revision = COALESCE(backlog_revision, 0) + 1,
      updated_at = v_now
  WHERE id = p_requirement_id;

  FOR v_plan IN
    SELECT id, status, steps
    FROM public.instance_plans
    WHERE id = p_plan_id
    FOR UPDATE
  LOOP
    SELECT jsonb_agg(
      CASE WHEN COALESCE(
        step.value->'metadata'->>'backlog_item_id',
        step.value->>'backlog_item_id'
      ) = ANY(v_affected)
        AND step.value->>'status' IN ('pending', 'in_progress', 'failed')
      THEN step.value || jsonb_build_object(
        'status', 'cancelled',
        'cancellation_reason', left(p_reason, 240),
        'cancelled_at', v_now
      )
      ELSE step.value END
      ORDER BY step.ordinality
    ) INTO v_next_steps
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(v_plan.steps) = 'array'
        THEN v_plan.steps ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS step(value, ordinality);
    SELECT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_next_steps) AS step(value)
      WHERE step.value->>'status' NOT IN (
        'completed', 'failed', 'cancelled', 'skipped', 'paused'
      )
    ) INTO v_plan_runnable;
    UPDATE public.instance_plans
    SET steps = v_next_steps,
        status = CASE WHEN v_plan_runnable
          THEN status ELSE 'cancelled' END,
        completion_reason = CASE WHEN v_plan_runnable
          THEN completion_reason
          ELSE 'Scoped backlog circuit cancelled all runnable steps' END,
        completed_at = CASE WHEN v_plan_runnable
          THEN completed_at ELSE COALESCE(completed_at, v_now) END,
        updated_at = v_now
    WHERE id = v_plan.id;
  END LOOP;

  RETURN jsonb_build_object(
    'state', 'applied',
    'isolated', true,
    'affected_item_ids', to_jsonb(v_affected),
    'generation', v_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.block_backlog_item_for_circuit_atomic(
  uuid, uuid, uuid, uuid, text, text, integer, integer, text, text, text,
  text, text, timestamptz, text, text, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.block_backlog_item_for_circuit_atomic(
  uuid, uuid, uuid, uuid, text, text, integer, integer, text, text, text,
  text, text, timestamptz, text, text, integer, integer, integer
) TO service_role;
