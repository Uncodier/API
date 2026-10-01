-- Preserve the originating instance and arbitrate assistant/cron admission.
-- No historical rows are reassigned, resumed, or backfilled by this migration.
CREATE OR REPLACE FUNCTION public.inspect_requirement_assistant_handoff(
  p_requirement_id uuid,
  p_instance_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requirement public.requirements%ROWTYPE;
  v_instance public.remote_instances%ROWTYPE;
  v_action public.instance_logs%ROWTYPE;
BEGIN
  SELECT * INTO v_requirement FROM public.requirements
  WHERE id = p_requirement_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'requirement_missing');
  END IF;
  SELECT * INTO v_instance FROM public.remote_instances
  WHERE id = p_instance_id AND site_id = v_requirement.site_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'original_instance_unavailable');
  END IF;
  IF v_instance.is_archived IS TRUE
    OR v_instance.status IN ('paused', 'stopped', 'stopping') THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'original_instance_paused');
  END IF;
  -- No time window: a long model/tool call is not evidence of failure.
  -- Inspect the whole instance because a fresh user turn may not be scoped yet.
  SELECT * INTO v_action FROM public.instance_logs
  WHERE instance_id = p_instance_id AND site_id = v_requirement.site_id
    AND log_type = 'user_action' AND trusted_user_action IS TRUE
  ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT FOUND THEN
    IF v_requirement.metadata->>'assistant_origin_instance_id' IS NOT NULL THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'assistant_handoff_not_confirmed');
    END IF;
    RETURN jsonb_build_object('allowed', true); -- legacy cron-only runner
  END IF;
  IF COALESCE(v_action.details->>'status', '') NOT IN ('completed', 'failed') THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'assistant_action_not_finished');
  END IF;
  -- A safe handoff resumes the same logical instance, not a new req-runner.
  RETURN jsonb_build_object('allowed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.inspect_requirement_assistant_handoff(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_requirement_assistant_handoff(uuid, uuid)
  TO service_role;

-- Serialize new user actions with activation on the requirement row. Do not
-- accept another executor while cron is already in flight on a bound instance.
CREATE OR REPLACE FUNCTION public.guard_requirement_assistant_admission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requirement public.requirements%ROWTYPE;
BEGIN
  IF NEW.log_type <> 'user_action' OR NEW.trusted_user_action IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;
  FOR v_requirement IN
    SELECT * FROM public.requirements
    WHERE site_id = NEW.site_id
      AND metadata->>'runner_instance_id' = NEW.instance_id::text
      AND metadata->>'assistant_origin_instance_id' IS NOT NULL
    ORDER BY id FOR UPDATE
  LOOP
    IF v_requirement.cron_lock_active IS TRUE
      AND v_requirement.cron_lock_run_id IS NOT NULL
      AND v_requirement.cron_lock_expires_at > clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'requirement_execution_busy';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_requirement_assistant_admission()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS guard_requirement_assistant_admission ON public.instance_logs;
CREATE TRIGGER guard_requirement_assistant_admission
  BEFORE INSERT ON public.instance_logs
  FOR EACH ROW EXECUTE FUNCTION public.guard_requirement_assistant_admission();

-- Activation and every existing cron dispatch assertion must see the same
-- handoff policy. Wrappers retain the previous capacity/generation/lease checks.
DO $$
BEGIN
  IF to_regprocedure('public.activate_requirement_cron_run_before_assistant_handoff(uuid,text,integer,integer)') IS NULL THEN
    ALTER FUNCTION public.activate_requirement_cron_run(uuid, text, integer, integer)
      RENAME TO activate_requirement_cron_run_before_assistant_handoff;
  END IF;
  IF to_regprocedure('public.assert_requirement_cron_execution_owner_before_assistant_handoff(uuid,text,integer,boolean,boolean)') IS NULL THEN
    ALTER FUNCTION public.assert_requirement_cron_execution_owner(uuid, text, integer, boolean, boolean)
      RENAME TO assert_requirement_cron_execution_owner_before_assistant_handoff;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_requirement_cron_run(
  p_requirement_id uuid, p_run_id text, p_max_concurrent integer, p_ttl_seconds integer DEFAULT 7200
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
  v_runner text;
BEGIN
  -- Existing function takes global capacity lock then requirement row lock.
  v_result := public.activate_requirement_cron_run_before_assistant_handoff(
    p_requirement_id, p_run_id, p_max_concurrent, p_ttl_seconds);
  IF v_result->>'state' <> 'active' THEN RETURN v_result; END IF;
  SELECT metadata->>'runner_instance_id' INTO v_runner FROM public.requirements
    WHERE id = p_requirement_id;
  -- The base activation still holds the global capacity advisory lock, so
  -- concurrent activations cannot both pass this same-instance admission test.
  -- One chat can create multiple requirements, but cannot execute them together.
  IF v_runner IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.requirements AS other
    WHERE other.id <> p_requirement_id
      AND other.metadata->>'runner_instance_id' = v_runner
      AND other.cron_lock_active IS TRUE
      AND other.cron_lock_run_id IS NOT NULL
      AND other.cron_lock_expires_at > clock_timestamp()
  ) THEN
    UPDATE public.requirements SET cron_lock_active = false
      WHERE id = p_requirement_id AND cron_lock_run_id = p_run_id;
    RETURN jsonb_build_object('state', 'stale');
  END IF;
  IF v_runner IS NOT NULL AND NOT (public.inspect_requirement_assistant_handoff(
    p_requirement_id, v_runner::uuid)->>'allowed')::boolean THEN
    UPDATE public.requirements SET cron_lock_active = false
      WHERE id = p_requirement_id AND cron_lock_run_id = p_run_id;
    RETURN jsonb_build_object('state', 'stale');
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_requirement_cron_execution_owner(
  p_requirement_id uuid, p_run_id text, p_expected_execution_generation integer,
  p_allow_inactive boolean DEFAULT false, p_allow_terminal boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
  v_handoff jsonb;
  v_runner text;
BEGIN
  v_result := public.assert_requirement_cron_execution_owner_before_assistant_handoff(
    p_requirement_id, p_run_id, p_expected_execution_generation, p_allow_inactive, p_allow_terminal);
  IF v_result->>'current' <> 'true' THEN RETURN v_result; END IF;
  SELECT metadata->>'runner_instance_id' INTO v_runner FROM public.requirements
    WHERE id = p_requirement_id;
  -- Terminal cleanup may stop the owned sandbox after a user pause. The base
  -- assertion still fences run/generation/expiry; this does not authorize work.
  IF v_runner IS NOT NULL AND p_allow_terminal IS NOT TRUE THEN
    v_handoff := public.inspect_requirement_assistant_handoff(p_requirement_id, v_runner::uuid);
    IF NOT (v_handoff->>'allowed')::boolean THEN
      RETURN jsonb_build_object('current', false, 'reason', v_handoff->>'reason');
    END IF;
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.activate_requirement_cron_run(uuid, text, integer, integer),
  public.assert_requirement_cron_execution_owner(uuid, text, integer, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_requirement_cron_run(uuid, text, integer, integer),
  public.assert_requirement_cron_execution_owner(uuid, text, integer, boolean, boolean)
  TO service_role;
-- The implementation functions are not alternate admission entry points.
REVOKE ALL ON FUNCTION public.activate_requirement_cron_run_before_assistant_handoff(uuid, text, integer, integer),
  public.assert_requirement_cron_execution_owner_before_assistant_handoff(uuid, text, integer, boolean, boolean)
  FROM PUBLIC, anon, authenticated, service_role;