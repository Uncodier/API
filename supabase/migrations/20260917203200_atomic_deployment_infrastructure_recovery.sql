-- Rollback:
-- DROP FUNCTION IF EXISTS public.recover_ready_deployment_infrastructure(uuid, uuid, uuid, text, text, text, text, text, boolean);
CREATE OR REPLACE FUNCTION public.recover_ready_deployment_infrastructure(
  p_requirement_id uuid, p_site_id uuid, p_instance_id uuid,
  p_branch text, p_commit_sha text, p_deployment_id text,
  p_preview_url text, p_recovery_id text, p_allow_legacy boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requirement_status text; v_requirement_metadata jsonb;
  v_requirement_site_id uuid;
  v_blocker_provenance text; v_blocker_event_id text;
  v_blocker_plan_id text; v_blocker_step_id text;
  v_blocker_generation integer;
  v_blocker_step_matched boolean := false;
  v_latest_stage text; v_latest_message text;
  v_legacy_audited boolean := false; v_deployment_blocker_audited boolean := false;
  v_matched boolean := false; v_legacy_matched boolean := false;
  v_has_product_failure boolean := false; v_requirement_reopened boolean := false;
  v_plan record;
  v_entry record;
  v_steps jsonb;
  v_step jsonb;
  v_new_step jsonb;
  v_correlation jsonb;
  v_structured_match boolean; v_legacy_match boolean;
  v_plan_matched boolean; v_plan_changed boolean; v_plan_has_failure boolean;
  v_generation integer; v_runner_instance_id uuid := p_instance_id;
  v_plan_ids jsonb := '[]'::jsonb;
  v_step_ids jsonb := '[]'::jsonb;
  v_audit_cycle text;
BEGIN
  IF NULLIF(btrim(p_branch), '') IS NULL OR NULLIF(btrim(p_commit_sha), '') IS NULL
    OR NULLIF(btrim(p_recovery_id), '') IS NULL THEN
    RAISE EXCEPTION 'Branch, commit SHA, and recovery id are required';
  END IF;
  SELECT status,
    CASE WHEN jsonb_typeof(metadata) = 'object'
      THEN metadata ELSE '{}'::jsonb END,
    site_id
  INTO v_requirement_status, v_requirement_metadata, v_requirement_site_id
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'matched', false, 'recovered', false,
      'requirement_reopened', false, 'plan_ids', v_plan_ids, 'step_ids', v_step_ids);
  END IF;
  IF v_requirement_site_id IS DISTINCT FROM p_site_id THEN
    RAISE EXCEPTION 'Requirement % does not belong to site %', p_requirement_id, p_site_id;
  END IF;
  IF v_requirement_status IN ('done', 'cancelled', 'canceled', 'on-review') THEN
    RETURN jsonb_build_object('state', 'guarded', 'matched', false, 'recovered', false,
      'requirement_reopened', false, 'plan_ids', v_plan_ids, 'step_ids', v_step_ids);
  END IF;
  v_blocker_provenance := v_requirement_metadata->>'cron_blocker_provenance';
  v_blocker_event_id := v_requirement_metadata->>'cron_blocker_event_id';
  v_blocker_plan_id := v_requirement_metadata->>'cron_blocker_plan_id';
  v_blocker_step_id := v_requirement_metadata->>'cron_blocker_step_id';
  v_blocker_generation := CASE
    WHEN COALESCE(v_requirement_metadata->>'cron_blocker_generation', '') ~ '^[0-9]{1,9}$'
      THEN (v_requirement_metadata->>'cron_blocker_generation')::integer
    ELSE -1
  END;
  SELECT stage, message
  INTO v_latest_stage, v_latest_message
  FROM public.requirement_status
  WHERE requirement_id = p_requirement_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  v_legacy_audited :=
    p_allow_legacy
    AND v_latest_stage = 'blocked'
    AND COALESCE(v_latest_message, '') ~*
      '(deploy gate|deployment).*(timeout|timed out|in time)';
  v_deployment_blocker_audited :=
    v_blocker_provenance = 'deployment_infrastructure'
    AND NULLIF(v_blocker_event_id, '') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.requirement_status
      WHERE requirement_id = p_requirement_id
        AND stage = 'blocked'
        AND cycle = 'infrastructure-circuit:' || v_blocker_event_id
    );
  IF v_requirement_status = 'blocked'
    AND v_blocker_provenance IN (
      'product_no_progress_circuit',
      'product_failure',
      'product_replan_circuit',
      'product_workflow_circuit'
    )
    AND NOT v_legacy_audited
  THEN
    RETURN jsonb_build_object('state', 'product_blocked', 'matched', false, 'recovered', false,
      'requirement_reopened', false, 'plan_ids', v_plan_ids, 'step_ids', v_step_ids);
  END IF;
  PERFORM 1
  FROM public.instance_plans
  WHERE (
      metadata->>'requirement_id' = p_requirement_id::text
      OR (
        p_instance_id IS NOT NULL
        AND instance_id = p_instance_id
        AND metadata->>'requirement_id' IS NULL
      )
    )
    AND status IN ('pending', 'in_progress', 'active', 'paused', 'failed', 'blocked')
  FOR UPDATE;
  FOR v_plan IN
    SELECT id, instance_id, status, metadata, steps
    FROM public.instance_plans
    WHERE (
        metadata->>'requirement_id' = p_requirement_id::text
        OR (
          p_instance_id IS NOT NULL
          AND instance_id = p_instance_id
          AND metadata->>'requirement_id' IS NULL
        )
      )
      AND status IN ('pending', 'in_progress', 'active', 'paused', 'failed', 'blocked')
  LOOP
    v_plan_matched := false;
    IF v_runner_instance_id IS NULL THEN
      v_runner_instance_id := v_plan.instance_id;
    END IF;
    FOR v_entry IN
      SELECT value, ordinality
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(v_plan.steps) = 'array' THEN v_plan.steps
          ELSE '[]'::jsonb
        END
      )
        WITH ORDINALITY
    LOOP
      v_step := v_entry.value;
      v_correlation := v_step->'infrastructure_correlation';
      v_structured_match := COALESCE((
        v_step->>'infrastructure_kind' = 'deployment'
        AND v_step->>'infrastructure_failure_provenance' =
          'deployment_infrastructure'
        AND v_correlation->>'requirement_id' = p_requirement_id::text
        AND v_correlation->>'plan_id' = v_plan.id::text
        AND v_correlation->>'step_id' = v_step->>'id'
        AND lower(v_correlation->>'branch') = lower(p_branch)
        AND lower(v_correlation->>'commit_sha') = lower(p_commit_sha)
      ), false);
      v_legacy_match := COALESCE((
        v_legacy_audited
        AND (
          v_correlation IS NULL
          OR v_correlation = 'null'::jsonb
        )
        AND v_step->>'status' IN ('failed', 'paused')
        AND COALESCE(
          v_step->>'error_message',
          v_step->>'infrastructure_error',
          ''
        ) ~* '(deploy gate|deployment).*(timeout|timed out|in time)'
        AND (
          COALESCE(
            substring(
              COALESCE(v_step->>'error_message', '') FROM
                'waiting for github deployment for ([0-9a-fA-F]{7,40})'
            ),
            ''
          ) = ''
          OR lower(p_commit_sha) LIKE lower(
            substring(
              COALESCE(v_step->>'error_message', '') FROM
                'waiting for github deployment for ([0-9a-fA-F]{7,40})'
            )
          ) || '%'
        )
      ), false);
      v_matched := v_matched OR v_structured_match OR v_legacy_match;
      IF v_structured_match
        AND v_plan.id::text = v_blocker_plan_id
        AND v_step->>'id' = v_blocker_step_id
        AND (CASE
          WHEN COALESCE(
            v_step->>'infrastructure_generation',
            ''
          ) ~ '^[0-9]{1,9}$'
            THEN (v_step->>'infrastructure_generation')::integer
          ELSE -1
        END) = v_blocker_generation
      THEN
        v_blocker_step_matched := true;
      END IF;
      v_plan_matched :=
        v_plan_matched OR v_structured_match OR v_legacy_match;
      v_legacy_matched := v_legacy_matched OR v_legacy_match;
      IF v_step->>'status' = 'failed'
        AND NOT (v_structured_match OR v_legacy_match)
      THEN
        v_has_product_failure := true;
      END IF;
    END LOOP;
    IF v_plan.status = 'failed' AND NOT v_plan_matched THEN
      v_has_product_failure := true;
    END IF;
  END LOOP;
  IF NOT v_matched THEN
    RETURN jsonb_build_object('state', CASE
        WHEN v_requirement_metadata->>'deployment_recovery_completed_key' =
          p_recovery_id
          THEN 'duplicate'
        ELSE 'unmatched'
      END,
      'matched', false, 'recovered', false, 'requirement_reopened', false,
      'plan_ids', v_plan_ids, 'step_ids', v_step_ids);
  END IF;
  IF v_requirement_status = 'blocked' AND (
    v_has_product_failure
    OR NOT (
      (
        v_blocker_provenance = 'deployment_infrastructure'
        AND v_deployment_blocker_audited
        AND v_blocker_step_matched
      )
      OR (
        v_legacy_matched
        AND v_legacy_audited
        AND (CASE
          WHEN COALESCE(
            v_requirement_metadata->>'deployment_recovery_version',
            ''
          ) ~ '^[0-9]{1,9}$'
            THEN (v_requirement_metadata->>'deployment_recovery_version')::integer
          ELSE 0
        END) < 1
      )
    )
  ) THEN
    RETURN jsonb_build_object('state', 'guarded', 'matched', true, 'recovered', false,
      'requirement_reopened', false, 'plan_ids', v_plan_ids, 'step_ids', v_step_ids);
  END IF;
  FOR v_plan IN
    SELECT id, instance_id, status, metadata, steps
    FROM public.instance_plans
    WHERE (
        metadata->>'requirement_id' = p_requirement_id::text
        OR (
          p_instance_id IS NOT NULL
          AND instance_id = p_instance_id
          AND metadata->>'requirement_id' IS NULL
        )
      )
      AND status IN ('pending', 'in_progress', 'active', 'paused', 'failed', 'blocked')
  LOOP
    v_steps := CASE
      WHEN jsonb_typeof(v_plan.steps) = 'array' THEN v_plan.steps
      ELSE '[]'::jsonb
    END;
    v_plan_changed := false;
    FOR v_entry IN
      SELECT value, ordinality
      FROM jsonb_array_elements(v_steps) WITH ORDINALITY
    LOOP
      v_step := v_entry.value;
      v_correlation := v_step->'infrastructure_correlation';
      v_structured_match := COALESCE((
        v_step->>'infrastructure_kind' = 'deployment'
        AND v_step->>'infrastructure_failure_provenance' =
          'deployment_infrastructure'
        AND v_correlation->>'requirement_id' = p_requirement_id::text
        AND v_correlation->>'plan_id' = v_plan.id::text
        AND v_correlation->>'step_id' = v_step->>'id'
        AND lower(v_correlation->>'branch') = lower(p_branch)
        AND lower(v_correlation->>'commit_sha') = lower(p_commit_sha)
      ), false);
      v_legacy_match := COALESCE((
        v_legacy_audited
        AND (
          v_correlation IS NULL
          OR v_correlation = 'null'::jsonb
        )
        AND v_step->>'status' IN ('failed', 'paused')
        AND COALESCE(
          v_step->>'error_message',
          v_step->>'infrastructure_error',
          ''
        ) ~* '(deploy gate|deployment).*(timeout|timed out|in time)'
        AND (
          COALESCE(
            substring(
              COALESCE(v_step->>'error_message', '') FROM
                'waiting for github deployment for ([0-9a-fA-F]{7,40})'
            ),
            ''
          ) = ''
          OR lower(p_commit_sha) LIKE lower(
            substring(
              COALESCE(v_step->>'error_message', '') FROM
                'waiting for github deployment for ([0-9a-fA-F]{7,40})'
            )
          ) || '%'
        )
      ), false);
      IF NOT (v_structured_match OR v_legacy_match) THEN
        CONTINUE;
      END IF;
      v_generation := CASE
        WHEN COALESCE(
          v_step->>'infrastructure_generation',
          ''
        ) ~ '^[0-9]{1,9}$'
          THEN (v_step->>'infrastructure_generation')::integer
        ELSE 0
      END;
      v_correlation := CASE
        WHEN v_correlation IS NULL OR v_correlation = 'null'::jsonb
        THEN jsonb_build_object(
          'requirement_id', p_requirement_id,
          'plan_id', v_plan.id,
          'step_id', v_step->>'id',
          'commit_sha', p_commit_sha,
          'branch', p_branch,
          'deployment_id', p_deployment_id
        )
        ELSE v_correlation
      END;
      v_new_step := v_step || jsonb_build_object(
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
        'infrastructure_generation', v_generation + 1,
        'infrastructure_last_event_id', p_recovery_id,
        'infrastructure_recovery', jsonb_build_object(
          'version', 1,
          'provenance', 'deployment_infrastructure',
          'correlation', v_correlation,
          'legacy_system_circuit', v_legacy_match,
          'recovered_at', timezone('utc', now())
        )
      );
      IF v_new_step->>'status' IN ('failed', 'paused') THEN
        v_new_step := v_new_step || jsonb_build_object(
          'status', 'in_progress',
          'completed_at', NULL,
          'retry_count', CASE
            WHEN COALESCE(
              v_step->>'infrastructure_product_retry_count',
              ''
            ) ~ '^[0-9]{1,9}$'
              THEN (v_step->>'infrastructure_product_retry_count')::integer
            ELSE 0
          END,
          'error_message', NULL
        );
      END IF;
      v_steps := jsonb_set(
        v_steps,
        ARRAY[(v_entry.ordinality - 1)::text],
        v_new_step,
        false
      );
      v_plan_changed := true;
      v_step_ids := v_step_ids || jsonb_build_array(v_step->>'id');
      INSERT INTO public.instance_plan_step_infrastructure_events (
        plan_id, step_id, event_id, event_type, details
      )
      VALUES (
        v_plan.id,
        v_step->>'id',
        p_recovery_id,
        'deployment_recovery',
        jsonb_build_object(
          'commit_sha', p_commit_sha,
          'branch', p_branch,
          'legacy', v_legacy_match,
          'generation', v_generation + 1
        )
      )
      ON CONFLICT (plan_id, step_id, event_id) DO NOTHING;
    END LOOP;
    IF v_plan_changed THEN
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_steps) AS step
        WHERE step->>'status' = 'failed'
      )
      INTO v_plan_has_failure;
      UPDATE public.instance_plans
      SET
        steps = v_steps,
        status = CASE
          WHEN NOT v_plan_has_failure
            AND v_plan.status IN ('failed', 'paused', 'blocked')
            THEN 'in_progress'
          ELSE v_plan.status
        END,
        completed_at = CASE
          WHEN NOT v_plan_has_failure
            AND v_plan.status IN ('failed', 'paused', 'blocked')
            THEN NULL
          ELSE completed_at
        END,
        updated_at = timezone('utc', now())
      WHERE id = v_plan.id;
      v_plan_ids := v_plan_ids || jsonb_build_array(v_plan.id);
    END IF;
  END LOOP;
  IF v_requirement_status IN ('backlog', 'blocked') THEN
    UPDATE public.requirements
    SET status = 'in-progress'
    WHERE id = p_requirement_id;
    v_requirement_reopened := true;
  END IF;
  v_requirement_metadata := v_requirement_metadata || jsonb_build_object(
    'deployment_recovery_version', 1,
    'deployment_recovery_commit_sha', p_commit_sha,
    'deployment_recovery_branch', p_branch,
    'deployment_recovery_completed_key', p_recovery_id,
    'requirement_execution_generation',
      CASE
        WHEN COALESCE(v_requirement_metadata->>'requirement_execution_generation', '') ~ '^[0-9]{1,9}$'
          THEN (v_requirement_metadata->>'requirement_execution_generation')::integer + 1
        ELSE 1
      END
  );
  IF v_requirement_status = 'blocked' THEN
    v_requirement_metadata := v_requirement_metadata -
      ARRAY[
        'cron_blocker_provenance',
        'cron_blocker_version',
        'cron_blocker_event_id',
        'cron_blocker_plan_id',
        'cron_blocker_step_id',
        'cron_blocker_generation'
      ];
  END IF;
  IF v_legacy_matched THEN
    v_requirement_metadata := v_requirement_metadata || jsonb_build_object(
      'cron_attempts', 0,
      'no_progress_cycles', 0
    );
  END IF;
  UPDATE public.requirements
  SET
    metadata = v_requirement_metadata,
    updated_at = timezone('utc', now())
  WHERE id = p_requirement_id;
  IF v_runner_instance_id IS NOT NULL THEN
    UPDATE public.remote_instances
    SET status = 'running'
    WHERE id = v_runner_instance_id
      AND status IN ('pending', 'paused');
  END IF;
  v_audit_cycle := 'deployment-recovery:' || p_recovery_id;
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
      preview_url,
      cycle,
      message
    )
    VALUES (
      p_requirement_id,
      p_site_id,
      v_runner_instance_id,
      'in-progress',
      p_preview_url,
      v_audit_cycle,
      'Deployment became ready for ' || p_branch || ' at ' ||
        left(p_commit_sha, 12) || '. Correlated infrastructure wait cleared.'
    );
  END IF;
  RETURN jsonb_build_object('state', 'applied', 'matched', true, 'recovered', true,
    'requirement_reopened', v_requirement_reopened,
    'plan_ids', v_plan_ids, 'step_ids', v_step_ids);
END;
$$;
REVOKE ALL ON FUNCTION public.recover_ready_deployment_infrastructure(uuid, uuid, uuid, text, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_ready_deployment_infrastructure(uuid, uuid, uuid, text, text, text, text, text, boolean) TO service_role;
