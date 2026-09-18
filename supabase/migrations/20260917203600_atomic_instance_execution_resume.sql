-- Rollback:
-- DROP FUNCTION IF EXISTS public.resume_instance_execution_on_user_action(uuid, uuid, boolean, text, boolean);

DROP FUNCTION IF EXISTS public.resume_instance_execution_on_user_action(uuid, boolean);
DROP FUNCTION IF EXISTS public.resume_instance_execution_on_user_action(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.resume_instance_execution_on_user_action(uuid, uuid, boolean, text);

CREATE OR REPLACE FUNCTION public.resume_instance_execution_on_user_action(
  p_requirement_id uuid,
  p_instance_id uuid,
  p_reopen_paused_plans boolean,
  p_action_id text,
  p_allow_terminal_reopen boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan record;
  v_steps jsonb;
  v_step jsonb;
  v_next_steps jsonb;
  v_generation integer;
  v_cleared boolean;
  v_resume boolean;
  v_requirement_status text;
  v_requirement_metadata jsonb;
  v_execution_generation integer;
  v_duplicate_action boolean;
  v_plans_updated integer := 0;
  v_steps_cleared integer := 0;
BEGIN
  SELECT
    status,
    CASE WHEN jsonb_typeof(metadata) = 'object'
      THEN metadata ELSE '{}'::jsonb END
  INTO v_requirement_status, v_requirement_metadata
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'state', 'missing', 'plans_updated', 0, 'steps_cleared', 0
    );
  END IF;
  IF v_requirement_status IN ('done', 'cancelled', 'canceled')
    AND NOT p_allow_terminal_reopen
  THEN
    RETURN jsonb_build_object(
      'state', 'guarded', 'plans_updated', 0, 'steps_cleared', 0
    );
  END IF;
  IF NULLIF(btrim(p_action_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_action_id is required';
  END IF;
  v_duplicate_action := COALESCE(
    v_requirement_metadata->>'requirement_last_resume_action_id' = p_action_id,
    false
  );
  IF v_duplicate_action
    AND (
      NOT p_reopen_paused_plans
      OR v_requirement_metadata->>'requirement_last_resume_reopened_plans' = 'true'
    )
  THEN
    RETURN jsonb_build_object(
      'state', 'duplicate',
      'plans_updated', 0,
      'steps_cleared', 0
    );
  END IF;
  v_execution_generation := CASE
    WHEN COALESCE(
      v_requirement_metadata->>'requirement_execution_generation',
      ''
    ) ~ '^[0-9]{1,9}$'
      THEN (v_requirement_metadata->>'requirement_execution_generation')::integer
    ELSE 0
  END;
  IF NOT v_duplicate_action THEN
    UPDATE public.requirements
    SET
      status = 'in-progress',
      metadata = (
        v_requirement_metadata - ARRAY[
          'cron_blocker_provenance',
          'cron_blocker_version',
          'cron_blocker_event_id',
          'cron_blocker_plan_id',
          'cron_blocker_step_id',
          'cron_blocker_generation'
        ]
      ) || jsonb_build_object(
        'cron_attempts', 0,
        'no_progress_cycles', 0,
        'cron_infrastructure_failure_cycles', 0,
        'requirement_execution_generation', v_execution_generation + 1,
        'requirement_last_resume_action_id', p_action_id,
        'requirement_last_resume_reopened_plans', p_reopen_paused_plans
      ),
      updated_at = timezone('utc', now())
    WHERE id = p_requirement_id;
  ELSE
    UPDATE public.requirements
    SET
      metadata = v_requirement_metadata || jsonb_build_object(
        'requirement_last_resume_reopened_plans', true
      ),
      updated_at = timezone('utc', now())
    WHERE id = p_requirement_id;
  END IF;

  FOR v_plan IN
    SELECT id, status, steps
    FROM public.instance_plans
    WHERE instance_id = p_instance_id
      AND metadata->>'requirement_id' = p_requirement_id::text
      AND (
        status IN ('pending', 'in_progress', 'active')
        OR (status = 'paused' AND p_reopen_paused_plans)
      )
    ORDER BY id
    FOR UPDATE
  LOOP
    v_steps := CASE WHEN jsonb_typeof(v_plan.steps) = 'array'
      THEN v_plan.steps ELSE '[]'::jsonb END;
    v_next_steps := '[]'::jsonb;
    v_cleared := false;

    FOR v_step IN SELECT value FROM jsonb_array_elements(v_steps)
    LOOP
      IF NOT v_duplicate_action
        AND COALESCE(v_step->>'status', 'pending')
        NOT IN ('completed', 'cancelled', 'canceled')
      THEN
        v_generation := CASE
          WHEN COALESCE(
            v_step->>'infrastructure_generation',
            ''
          ) ~ '^[0-9]{1,9}$'
            THEN (v_step->>'infrastructure_generation')::integer
          ELSE 0
        END;
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
          'infrastructure_product_retry_count', NULL,
          'infrastructure_generation', v_generation + 1
        );
        v_cleared := true;
        v_steps_cleared := v_steps_cleared + 1;
      END IF;
      v_next_steps := v_next_steps || jsonb_build_array(v_step);
    END LOOP;

    v_resume := v_plan.status = 'paused' AND p_reopen_paused_plans;
    IF v_cleared OR v_resume THEN
      UPDATE public.instance_plans
      SET
        steps = CASE WHEN v_cleared THEN v_next_steps ELSE v_steps END,
        status = CASE WHEN v_resume THEN 'in_progress' ELSE status END,
        completed_at = CASE WHEN v_resume THEN NULL ELSE completed_at END,
        updated_at = timezone('utc', now())
      WHERE id = v_plan.id;
      v_plans_updated := v_plans_updated + 1;
    END IF;
  END LOOP;

  UPDATE public.remote_instances
  SET status = 'running'
  WHERE id = p_instance_id
    AND status IN ('pending', 'paused');

  RETURN jsonb_build_object(
    'state', 'applied',
    'plans_updated', v_plans_updated,
    'steps_cleared', v_steps_cleared
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resume_instance_execution_on_user_action(uuid, uuid, boolean, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_instance_execution_on_user_action(uuid, uuid, boolean, text, boolean) TO service_role;
