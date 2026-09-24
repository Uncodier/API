-- Rollback:
--   Drop requirements_review_quarantine_guard and its two helper functions.
--   Drop instance_logs.trusted_user_action and both new requirements columns.
--   Reapply 20260917203600_atomic_instance_execution_resume.sql for the old RPC.
ALTER TABLE IF EXISTS public.instance_logs ADD COLUMN IF NOT EXISTS trusted_user_action boolean NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS public.requirements ADD COLUMN IF NOT EXISTS external_user_action_revision bigint NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS last_external_user_action_id text;
COMMENT ON COLUMN public.instance_logs.trusted_user_action IS 'True only for authenticated external user input; agent logging APIs must never set it.';
COMMENT ON COLUMN public.requirements.external_user_action_revision IS 'Monotonic authority used to release needs_review backlog quarantines.';
COMMENT ON COLUMN public.requirements.last_external_user_action_id IS 'Trusted instance_logs action consumed by the latest recovery transaction.';
CREATE INDEX IF NOT EXISTS idx_instance_logs_trusted_user_action ON public.instance_logs (instance_id, created_at DESC, id DESC) WHERE log_type = 'user_action' AND trusted_user_action = true;

CREATE OR REPLACE FUNCTION public.requirement_quarantine_timestamp(p_item jsonb)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_value text;
BEGIN
  v_value := COALESCE(
    NULLIF(p_item->'review_quarantine'->>'quarantined_at', ''),
    NULLIF(p_item->>'updated_at', '')
  );
  IF v_value IS NULL THEN
    RETURN 'infinity'::timestamptz;
  END IF;
  RETURN v_value::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN 'infinity'::timestamptz;
END;
$$;

REVOKE ALL ON FUNCTION public.requirement_quarantine_timestamp(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requirement_quarantine_timestamp(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_requirement_review_quarantine()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_old_item jsonb;
  v_new_item jsonb;
  v_action_created_at timestamptz;
BEGIN
  IF NEW.backlog IS NOT DISTINCT FROM OLD.backlog THEN
    RETURN NEW;
  END IF;

  FOR v_old_item IN
    SELECT value
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(OLD.backlog->'items') = 'array'
          THEN OLD.backlog->'items'
        ELSE '[]'::jsonb
      END
    )
    WHERE value->>'status' = 'needs_review'
      OR COALESCE(value->'review_quarantine'->>'active', 'false') = 'true'
  LOOP
    SELECT value INTO v_new_item
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(NEW.backlog->'items') = 'array'
          THEN NEW.backlog->'items'
        ELSE '[]'::jsonb
      END
    )
    WHERE value->>'id' = v_old_item->>'id'
    LIMIT 1;

    IF v_new_item IS NULL
      OR v_new_item->>'status' <> 'needs_review'
      OR COALESCE(
        v_new_item->'review_quarantine'->>'active',
        'false'
      ) <> 'true'
    THEN
      IF NEW.external_user_action_revision
          <> OLD.external_user_action_revision + 1
        OR NULLIF(NEW.last_external_user_action_id, '') IS NULL
        OR v_new_item IS NULL
        OR v_new_item->'review_quarantine'->>'released_by_action_id'
          IS DISTINCT FROM NEW.last_external_user_action_id
      THEN
        RAISE EXCEPTION
          'Backlog item % is quarantined; a trusted newer user action must release it',
          v_old_item->>'id';
      END IF;

      SELECT log.created_at INTO v_action_created_at
      FROM public.instance_logs AS log
      WHERE log.id::text = NEW.last_external_user_action_id
        AND log.log_type = 'user_action'
        AND log.trusted_user_action = true
        AND log.details->>'requirement_id' = NEW.id::text
      LIMIT 1;

      IF v_action_created_at IS NULL
        OR v_action_created_at <=
          public.requirement_quarantine_timestamp(v_old_item)
      THEN
        RAISE EXCEPTION
          'Backlog item % quarantine predates no trusted user action',
          v_old_item->>'id';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS requirements_review_quarantine_guard ON public.requirements;
CREATE TRIGGER requirements_review_quarantine_guard
  BEFORE UPDATE OF backlog ON public.requirements
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_requirement_review_quarantine();

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
  v_step jsonb;
  v_item jsonb;
  v_steps jsonb;
  v_next_steps jsonb;
  v_next_items jsonb := '[]'::jsonb;
  v_failures jsonb;
  v_backlog jsonb;
  v_metadata jsonb;
  v_status text;
  v_action_uuid uuid;
  v_action_created_at timestamptz;
  v_trusted_action boolean := false;
  v_receipt_inserted integer := 0;
  v_external_revision bigint;
  v_execution_generation integer;
  v_generation integer;
  v_cleared boolean;
  v_resume boolean;
  v_plans_updated integer := 0;
  v_steps_cleared integer := 0;
  v_reopened_ids text[] := ARRAY[]::text[];
  v_now timestamptz := timezone('utc', now());
BEGIN
  IF NULLIF(btrim(p_action_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_action_id is required';
  END IF;

  SELECT
    status,
    CASE WHEN jsonb_typeof(metadata) = 'object'
      THEN metadata ELSE '{}'::jsonb END,
    CASE WHEN jsonb_typeof(backlog) = 'object'
      THEN backlog ELSE '{}'::jsonb END,
    external_user_action_revision
  INTO
    v_status,
    v_metadata,
    v_backlog,
    v_external_revision
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'state', 'missing',
      'plans_updated', 0,
      'steps_cleared', 0,
      'reopened_item_ids', '[]'::jsonb,
      'external_user_action_revision', 0
    );
  END IF;
  IF v_status IN ('done', 'cancelled', 'canceled')
    AND NOT p_allow_terminal_reopen
  THEN
    RETURN jsonb_build_object(
      'state', 'guarded',
      'plans_updated', 0,
      'steps_cleared', 0,
      'reopened_item_ids', '[]'::jsonb,
      'external_user_action_revision', v_external_revision
    );
  END IF;
  SELECT log.id, log.created_at
  INTO v_action_uuid, v_action_created_at
  FROM public.instance_logs AS log
  WHERE log.id::text = p_action_id
    AND log.instance_id = p_instance_id
    AND log.log_type = 'user_action'
    AND log.trusted_user_action = true
    AND log.details->>'requirement_id' = p_requirement_id::text
  LIMIT 1;
  v_trusted_action := FOUND;
  IF NOT v_trusted_action AND NOT p_allow_terminal_reopen THEN
    RETURN jsonb_build_object(
      'state', 'untrusted',
      'plans_updated', 0,
      'steps_cleared', 0,
      'reopened_item_ids', '[]'::jsonb,
      'external_user_action_revision', v_external_revision
    );
  END IF;
  IF v_trusted_action THEN
    INSERT INTO public.requirement_user_action_receipts (
      requirement_id,
      action_id,
      action_created_at,
      revision
    ) VALUES (
      p_requirement_id,
      v_action_uuid,
      v_action_created_at,
      v_external_revision + 1
    )
    ON CONFLICT (requirement_id, action_id) DO NOTHING;
    GET DIAGNOSTICS v_receipt_inserted = ROW_COUNT;
  END IF;
  IF (v_trusted_action AND v_receipt_inserted = 0) OR (
    NOT v_trusted_action
    AND v_metadata->>'requirement_last_resume_action_id' = p_action_id
  ) THEN
    RETURN jsonb_build_object(
      'state', 'duplicate',
      'plans_updated', 0,
      'steps_cleared', 0,
      'reopened_item_ids', '[]'::jsonb,
      'external_user_action_revision', v_external_revision
    );
  END IF;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(v_backlog->'items') = 'array'
        THEN v_backlog->'items' ELSE '[]'::jsonb END
    ) WITH ORDINALITY
    ORDER BY ordinality
  LOOP
    IF v_trusted_action
      AND v_item->>'status' = 'needs_review'
      AND COALESCE(
        v_item->'review_quarantine'->>'active',
        'false'
      ) = 'true'
      AND v_action_created_at >
        public.requirement_quarantine_timestamp(v_item)
      AND COALESCE(
        NULLIF(
          v_item->'review_quarantine'->>'external_action_revision',
          ''
        )::bigint,
        v_external_revision
      ) <= v_external_revision
    THEN
      SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      INTO v_failures
      FROM jsonb_each(
        CASE WHEN jsonb_typeof(v_item->'tool_failures') = 'object'
          THEN v_item->'tool_failures' ELSE '{}'::jsonb END
      ) AS entry(key, value)
      WHERE entry.key NOT LIKE 'judge\_%' ESCAPE '\';

      v_item := (
        v_item
        - 'tool_failures'
        - 'plan_cancellation_pending'
      ) || jsonb_build_object(
        'status', 'pending',
        'attempts', 0,
        'updated_at', v_now,
        'review_quarantine',
          v_item->'review_quarantine' || jsonb_build_object(
            'active', false,
            'released_at', v_now,
            'released_by_action_id', p_action_id,
            'external_action_revision', v_external_revision + 1
          )
      );
      IF v_failures <> '{}'::jsonb THEN
        v_item := v_item || jsonb_build_object(
          'tool_failures', v_failures
        );
      END IF;
      IF NOT COALESCE(v_item->'assumptions', '[]'::jsonb)
        @> jsonb_build_array(
          '[user-feedback] Reopened for mandatory execution and validation.'
        )
      THEN
        v_item := v_item || jsonb_build_object(
          'assumptions',
          COALESCE(v_item->'assumptions', '[]'::jsonb) ||
            jsonb_build_array(
              '[user-feedback] Reopened for mandatory execution and validation.'
            )
        );
      END IF;
      v_reopened_ids := array_append(v_reopened_ids, v_item->>'id');
    END IF;
    v_next_items := v_next_items || jsonb_build_array(v_item);
  END LOOP;

  v_execution_generation := CASE
    WHEN COALESCE(
      v_metadata->>'requirement_execution_generation',
      ''
    ) ~ '^[0-9]{1,9}$'
      THEN (v_metadata->>'requirement_execution_generation')::integer
    ELSE 0
  END;
  UPDATE public.requirements
  SET
    status = 'in-progress',
    backlog = CASE
      WHEN cardinality(v_reopened_ids) > 0
        THEN jsonb_set(v_backlog, '{items}', v_next_items, true)
      ELSE backlog
    END,
    backlog_revision = backlog_revision
      + CASE WHEN cardinality(v_reopened_ids) > 0 THEN 1 ELSE 0 END,
    external_user_action_revision = v_external_revision
      + CASE WHEN v_trusted_action THEN 1 ELSE 0 END,
    last_external_user_action_id = CASE
      WHEN v_trusted_action THEN p_action_id
      ELSE last_external_user_action_id
    END,
    metadata = (
      v_metadata - ARRAY[
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
      'requirement_last_resume_reopened_plans',
        p_reopen_paused_plans AND v_status IN ('blocked', 'on-review')
    ),
    updated_at = v_now
  WHERE id = p_requirement_id;

  FOR v_plan IN
    SELECT id, status, steps
    FROM public.instance_plans
    WHERE instance_id = p_instance_id
      AND metadata->>'requirement_id' = p_requirement_id::text
      AND (
        status IN ('pending', 'in_progress', 'active')
        OR (
          status = 'paused'
          AND p_reopen_paused_plans
          AND v_status IN ('blocked', 'on-review')
        )
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
      IF COALESCE(v_step->>'status', 'pending')
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

    v_resume := v_plan.status = 'paused'
      AND p_reopen_paused_plans
      AND v_status IN ('blocked', 'on-review');
    IF v_cleared OR v_resume THEN
      UPDATE public.instance_plans
      SET
        steps = CASE WHEN v_cleared THEN v_next_steps ELSE v_steps END,
        status = CASE WHEN v_resume THEN 'in_progress' ELSE status END,
        completed_at = CASE WHEN v_resume THEN NULL ELSE completed_at END,
        updated_at = v_now
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
    'steps_cleared', v_steps_cleared,
    'reopened_item_ids', to_jsonb(v_reopened_ids),
    'external_user_action_revision', v_external_revision + CASE WHEN v_trusted_action THEN 1 ELSE 0 END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resume_instance_execution_on_user_action(uuid, uuid, boolean, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_instance_execution_on_user_action(uuid, uuid, boolean, text, boolean) TO service_role;
