-- Offline-reviewed forward migration only. Archival is not pause/resume authority.
-- The receipt is host-authored evidence, never a model-writable metadata field.
BEGIN;

CREATE TABLE IF NOT EXISTS public.requirement_archived_runner_reassignments (
  requirement_id uuid NOT NULL REFERENCES public.requirements(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  previous_instance_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  run_id text NOT NULL CHECK (btrim(run_id) <> ''),
  previous_execution_generation integer NOT NULL CHECK (previous_execution_generation >= 0),
  execution_generation integer NOT NULL CHECK (execution_generation > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (requirement_id, run_id),
  UNIQUE (requirement_id, execution_generation),
  UNIQUE (instance_id),
  CHECK (instance_id <> previous_instance_id),
  CHECK (execution_generation::bigint = previous_execution_generation::bigint + 1)
);
-- Instance references deliberately have no FK: removing a sandbox must not
-- erase the requirement's historical evidence or block its root deletion.
ALTER TABLE public.requirement_archived_runner_reassignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.requirement_archived_runner_reassignments
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.requirement_archived_runner_reassignments TO service_role;
DROP POLICY IF EXISTS archived_runner_receipts_service_read ON public.requirement_archived_runner_reassignments;
CREATE POLICY archived_runner_receipts_service_read ON public.requirement_archived_runner_reassignments
  FOR SELECT TO service_role USING (true);

CREATE OR REPLACE FUNCTION public.guard_archived_runner_reassignment_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.requirements WHERE id = OLD.requirement_id
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Archived runner reassignment history is append-only'
    USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.guard_archived_runner_reassignment_history()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS archived_runner_reassignment_append_only ON public.requirement_archived_runner_reassignments;
CREATE TRIGGER archived_runner_reassignment_append_only
  BEFORE UPDATE OR DELETE ON public.requirement_archived_runner_reassignments
  FOR EACH ROW EXECUTE FUNCTION public.guard_archived_runner_reassignment_history();
DROP TRIGGER IF EXISTS archived_runner_reassignment_no_truncate ON public.requirement_archived_runner_reassignments;
CREATE TRIGGER archived_runner_reassignment_no_truncate
  BEFORE TRUNCATE ON public.requirement_archived_runner_reassignments
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_archived_runner_reassignment_history();

CREATE OR REPLACE FUNCTION public.replace_archived_requirement_runner(
  p_requirement_id uuid,
  p_run_id text,
  p_expected_instance_id uuid,
  p_expected_execution_generation integer
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_requirement public.requirements%ROWTYPE;
  v_instance public.remote_instances%ROWTYPE;
  v_action public.instance_logs%ROWTYPE;
  v_receipt public.requirement_archived_runner_reassignments%ROWTYPE;
  v_metadata jsonb;
  v_generation integer;
  v_generation_text text;
  v_owner text;
  v_origin text;
  v_discovered_owner uuid;
  v_new_instance_id uuid;
  v_plan public.instance_plans%ROWTYPE;
  v_plan_ids uuid[] := '{}'::uuid[];
  v_item_ids text[];
  v_references_valid boolean;
  v_reference_count integer;
BEGIN
  IF p_requirement_id IS NULL OR p_expected_instance_id IS NULL
    OR NULLIF(btrim(p_run_id), '') IS NULL
    OR p_expected_execution_generation IS NULL
    OR p_expected_execution_generation < 0 OR p_expected_execution_generation >= 2147483647
  THEN RETURN jsonb_build_object('state', 'guarded', 'reason', 'missing_execution_identity'); END IF;

  -- Same order as claim/activation; prevents overlapping admission on old owner.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('requirement-cron-global-capacity', 0));
  SELECT * INTO v_requirement FROM public.requirements WHERE id = p_requirement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'guarded', 'reason', 'requirement_missing'); END IF;
  IF v_requirement.cron_lock_run_id IS DISTINCT FROM p_run_id THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'run_owner_changed');
  END IF;
  IF v_requirement.cron_lock_expires_at IS NULL
    OR v_requirement.cron_lock_expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'lease_expired');
  END IF;
  IF v_requirement.cron_lock_active IS DISTINCT FROM false THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'execution_active');
  END IF;
  IF COALESCE(v_requirement.status, '') NOT IN ('backlog', 'in-progress') THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'execution_not_runnable');
  END IF;
  IF v_requirement.site_id IS NULL OR v_requirement.user_id IS NULL THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'requirement_identity_missing');
  END IF;
  IF v_requirement.metadata IS NOT NULL AND jsonb_typeof(v_requirement.metadata) <> 'object' THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'invalid_requirement_metadata');
  END IF;
  v_metadata := COALESCE(v_requirement.metadata, '{}'::jsonb);
  v_generation_text := v_metadata->>'requirement_execution_generation';
  v_generation := 0;
  IF v_metadata ? 'requirement_execution_generation' THEN
    IF v_generation_text IS NULL OR v_generation_text !~ '^[0-9]{1,10}$'
      OR v_generation_text::bigint > 2147483647 THEN
      RETURN jsonb_build_object('state', 'guarded', 'reason', 'invalid_execution_generation');
    END IF;
    v_generation := v_generation_text::integer;
  END IF;
  v_owner := v_metadata->>'runner_instance_id';
  v_origin := v_metadata->>'assistant_origin_instance_id';
  IF v_origin IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.remote_instances WHERE id::text = v_origin AND site_id = v_requirement.site_id
  ) THEN RETURN jsonb_build_object('state', 'guarded', 'reason', 'assistant_origin_unavailable'); END IF;

  SELECT * INTO v_receipt FROM public.requirement_archived_runner_reassignments
    WHERE requirement_id = p_requirement_id AND run_id = p_run_id;
  IF FOUND THEN
    IF v_receipt.site_id = v_requirement.site_id
      AND v_receipt.previous_instance_id = p_expected_instance_id
      AND v_receipt.previous_execution_generation = p_expected_execution_generation
      AND v_receipt.execution_generation = v_generation
      AND v_receipt.instance_id::text = v_owner
      AND EXISTS (SELECT 1 FROM public.remote_instances WHERE id = v_receipt.instance_id
        AND site_id = v_requirement.site_id AND is_archived IS FALSE)
    THEN RETURN jsonb_build_object('state', 'duplicate', 'instance_id', v_receipt.instance_id,
      'execution_generation', v_generation, 'metadata', v_metadata); END IF;
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'replacement_receipt_changed');
  END IF;
  IF v_generation <> p_expected_execution_generation THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'execution_generation_changed');
  END IF;
  SELECT * INTO v_instance FROM public.remote_instances WHERE id = p_expected_instance_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'guarded', 'reason', 'original_instance_unavailable'); END IF;
  IF v_instance.site_id IS DISTINCT FROM v_requirement.site_id THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'instance_site_mismatch');
  END IF;
  IF v_owner IS NOT NULL THEN
    IF v_owner IS DISTINCT FROM p_expected_instance_id::text THEN
      RETURN jsonb_build_object('state', 'guarded', 'reason', 'runner_instance_owner_changed');
    END IF;
  ELSE
    -- Legacy discovery must be reproducible, never caller-provided authority.
    -- A known origin wins; otherwise use the earliest non-maintenance plan owner.
    IF v_origin IS NOT NULL THEN
      v_discovered_owner := CASE WHEN v_origin = p_expected_instance_id::text THEN p_expected_instance_id ELSE NULL END;
    ELSE
      IF EXISTS (SELECT 1 FROM public.instance_plans AS plan
        LEFT JOIN public.remote_instances AS instance ON instance.id = plan.instance_id
        WHERE plan.site_id = v_requirement.site_id AND plan.metadata->>'requirement_id' = p_requirement_id::text
          AND (instance.id IS NULL OR instance.site_id IS DISTINCT FROM v_requirement.site_id)) THEN
        RETURN jsonb_build_object('state', 'guarded', 'reason', 'original_instance_unavailable');
      END IF;
      SELECT plan.instance_id INTO v_discovered_owner FROM public.instance_plans AS plan
        JOIN public.remote_instances AS instance ON instance.id = plan.instance_id
        WHERE plan.site_id = v_requirement.site_id AND plan.metadata->>'requirement_id' = p_requirement_id::text
          AND instance.site_id = v_requirement.site_id AND instance.name NOT LIKE 'req-maint-%'
        ORDER BY plan.created_at ASC, plan.id ASC LIMIT 1;
      IF v_discovered_owner IS NULL AND v_instance.name = 'req-runner-' || p_requirement_id::text THEN
        v_discovered_owner := p_expected_instance_id;
      END IF;
    END IF;
    IF v_discovered_owner IS DISTINCT FROM p_expected_instance_id THEN
      RETURN jsonb_build_object('state', 'guarded', 'reason', 'runner_instance_owner_changed');
    END IF;
  END IF;
  IF v_instance.is_archived IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'original_instance_not_archived');
  END IF;
  -- Archive is explicit intent, not proof that an in-flight assistant tool has
  -- quiesced. Never infer completion from age/provider silence. Completed/failed
  -- are authoritative terminal outcomes: the failure writer intentionally keeps
  -- the last recovery snapshot, whose inFlight bit is not a live tool lease.
  -- A pause/cancellation with inFlight still set remains ambiguous and guarded.
  SELECT * INTO v_action FROM public.instance_logs
    WHERE instance_id = p_expected_instance_id AND site_id = v_requirement.site_id
      AND log_type = 'user_action' AND trusted_user_action IS TRUE
    ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE;
  IF FOUND AND (COALESCE(v_action.details->>'status', '') NOT IN (
    'completed', 'failed', 'paused', 'stopped', 'cancelled'
  ) OR (v_action.details->>'status' NOT IN ('completed', 'failed')
    AND v_action.details->'assistant_recovery'->>'inFlight' = 'true')) THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'original_assistant_action_not_finished');
  END IF;
  IF EXISTS (SELECT 1 FROM public.requirements AS other
    WHERE other.id <> p_requirement_id AND other.cron_lock_active IS TRUE
      AND other.cron_lock_run_id IS NOT NULL AND other.cron_lock_expires_at > clock_timestamp()
      AND (other.metadata->>'runner_instance_id' = p_expected_instance_id::text
        OR (other.metadata->>'runner_instance_id' IS NULL
          AND other.metadata->>'assistant_origin_instance_id' = p_expected_instance_id::text))) THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'original_instance_execution_active');
  END IF;
  IF EXISTS (SELECT 1 FROM public.remote_instances WHERE site_id = v_requirement.site_id
    AND name = 'req-runner-' || p_requirement_id::text AND is_archived IS NOT TRUE) THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'canonical_runner_exists');
  END IF;
  IF EXISTS (SELECT 1 FROM public.instance_plans AS plan
    JOIN public.remote_instances AS instance ON instance.id = plan.instance_id
    WHERE plan.site_id = v_requirement.site_id AND plan.metadata->>'requirement_id' = p_requirement_id::text
      AND plan.instance_id <> p_expected_instance_id
      AND plan.status IN ('pending', 'in_progress', 'active', 'paused')
      AND instance.is_archived IS NOT TRUE AND instance.name NOT LIKE 'req-maint-%') THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'competing_instance_active');
  END IF;

  SELECT COALESCE(array_agg(item->>'id'), '{}'::text[]) INTO v_item_ids
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_requirement.backlog->'items') = 'array'
      THEN v_requirement.backlog->'items' ELSE '[]'::jsonb END) AS item
    WHERE jsonb_typeof(item->'id') = 'string' AND btrim(item->>'id') <> '';
  -- Lock source candidates before classifying them. A supported legacy plan
  -- cannot be silently left behind while a new runner replans completed work.
  -- The captured IDs are the exact transfer set; no broad post-insert UPDATE.
  FOR v_plan IN SELECT * FROM public.instance_plans
    WHERE instance_id = p_expected_instance_id AND site_id = v_requirement.site_id
      AND status IN ('pending', 'in_progress', 'active', 'paused') ORDER BY id FOR UPDATE
  LOOP
    IF v_plan.metadata->'workflow_run' = 'true'::jsonb
      OR v_plan.metadata->'workflow_template' = 'true'::jsonb THEN CONTINUE; END IF;
    IF v_plan.metadata->>'requirement_id' IS NOT NULL THEN
      IF v_plan.metadata->>'requirement_id' = p_requirement_id::text THEN
        v_plan_ids := array_append(v_plan_ids, v_plan.id);
      END IF;
      CONTINUE; -- An explicit different requirement is never transferable.
    END IF;
    -- Legacy association must be unambiguous: no shared historical owner, no
    -- malformed shape, and every declared plan/step backlog link belongs here.
    IF (v_plan.metadata IS NOT NULL AND jsonb_typeof(v_plan.metadata) <> 'object')
      OR jsonb_typeof(v_plan.steps) IS DISTINCT FROM 'array'
      OR EXISTS (SELECT 1 FROM public.requirements AS other
        WHERE other.id <> p_requirement_id
          AND (other.metadata->>'runner_instance_id' = p_expected_instance_id::text
            OR other.metadata->>'assistant_origin_instance_id' = p_expected_instance_id::text))
      OR EXISTS (SELECT 1 FROM public.instance_plans AS other
        WHERE other.instance_id = p_expected_instance_id AND other.site_id = v_requirement.site_id
          AND other.metadata->>'requirement_id' IS NOT NULL
          AND other.metadata->>'requirement_id' <> p_requirement_id::text
          AND other.metadata->'workflow_run' IS DISTINCT FROM 'true'::jsonb
          AND other.metadata->'workflow_template' IS DISTINCT FROM 'true'::jsonb)
    THEN RETURN jsonb_build_object('state', 'guarded', 'reason', 'legacy_plan_scope_ambiguous'); END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan.steps) AS step
      WHERE jsonb_typeof(step) IS DISTINCT FROM 'object'
        OR (step ? 'metadata' AND step->'metadata' <> 'null'::jsonb
          AND jsonb_typeof(step->'metadata') <> 'object')) THEN
      RETURN jsonb_build_object('state', 'guarded', 'reason', 'legacy_plan_scope_ambiguous');
    END IF;
    SELECT count(*)::integer, COALESCE(bool_and(
      jsonb_typeof(reference) = 'string' AND (reference #>> '{}') = ANY(v_item_ids)), false)
      INTO v_reference_count, v_references_valid
      FROM (
        SELECT v_plan.metadata->'backlog_item_id' AS reference
        UNION ALL SELECT step->'backlog_item_id' FROM jsonb_array_elements(v_plan.steps) AS step
        UNION ALL SELECT step->'metadata'->'backlog_item_id' FROM jsonb_array_elements(v_plan.steps) AS step
      ) AS references_to_check
      WHERE reference IS NOT NULL AND reference <> 'null'::jsonb;
    IF v_reference_count = 0 OR NOT v_references_valid THEN
      RETURN jsonb_build_object('state', 'guarded', 'reason', 'legacy_plan_scope_ambiguous');
    END IF;
    v_plan_ids := array_append(v_plan_ids, v_plan.id);
  END LOOP;
  IF v_requirement.cron_lock_expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('state', 'guarded', 'reason', 'lease_expired');
  END IF;
  INSERT INTO public.remote_instances(name, instance_type, status, is_archived, site_id, user_id, created_by)
    VALUES ('req-runner-' || p_requirement_id::text, 'browser', 'pending', false,
      v_requirement.site_id, v_requirement.user_id, v_requirement.user_id)
    RETURNING id INTO v_new_instance_id;
  v_metadata := v_metadata || jsonb_build_object('runner_instance_id', v_new_instance_id,
    'requirement_execution_generation', v_generation + 1);
  UPDATE public.requirements SET metadata = v_metadata WHERE id = p_requirement_id;
  UPDATE public.instance_plans SET instance_id = v_new_instance_id
    WHERE id = ANY(v_plan_ids) AND instance_id = p_expected_instance_id AND site_id = v_requirement.site_id
      AND status IN ('pending', 'in_progress', 'active', 'paused');
  INSERT INTO public.requirement_archived_runner_reassignments(requirement_id, site_id,
    previous_instance_id, instance_id, run_id, previous_execution_generation, execution_generation)
    VALUES (p_requirement_id, v_requirement.site_id, p_expected_instance_id, v_new_instance_id,
      p_run_id, v_generation, v_generation + 1);
  RETURN jsonb_build_object('state', 'replaced', 'instance_id', v_new_instance_id,
    'execution_generation', v_generation + 1, 'metadata', v_metadata);
END;
$$;
REVOKE ALL ON FUNCTION public.replace_archived_requirement_runner(uuid, text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_archived_requirement_runner(uuid, text, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.inspect_requirement_assistant_handoff(
  p_requirement_id uuid, p_instance_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_requirement public.requirements%ROWTYPE;
  v_instance public.remote_instances%ROWTYPE;
  v_action public.instance_logs%ROWTYPE;
BEGIN
  SELECT * INTO v_requirement FROM public.requirements WHERE id = p_requirement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'reason', 'requirement_missing'); END IF;
  IF v_requirement.metadata->>'assistant_origin_instance_id' IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.remote_instances
      WHERE id::text = v_requirement.metadata->>'assistant_origin_instance_id'
        AND site_id = v_requirement.site_id) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'assistant_origin_unavailable');
  END IF;
  IF v_requirement.metadata->>'runner_instance_id' IS NOT NULL
    AND v_requirement.metadata->>'runner_instance_id' IS DISTINCT FROM p_instance_id::text THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'runner_instance_owner_changed');
  END IF;
  SELECT * INTO v_instance FROM public.remote_instances
    WHERE id = p_instance_id AND site_id = v_requirement.site_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'reason', 'original_instance_unavailable'); END IF;
  IF v_instance.is_archived IS TRUE THEN
    -- This inspector runs before preparation, which may write backlog/resume
    -- state. Do not authorize that phase while an old assistant is still active.
    -- The replacement transaction repeats this check under row locks.
    SELECT * INTO v_action FROM public.instance_logs
      WHERE instance_id = p_instance_id AND site_id = v_requirement.site_id
        AND log_type = 'user_action' AND trusted_user_action IS TRUE
      ORDER BY created_at DESC, id DESC LIMIT 1;
    IF FOUND AND (COALESCE(v_action.details->>'status', '') NOT IN (
      'completed', 'failed', 'paused', 'stopped', 'cancelled'
    ) OR (v_action.details->>'status' NOT IN ('completed', 'failed')
      AND v_action.details->'assistant_recovery'->>'inFlight' = 'true')) THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'original_assistant_action_not_finished');
    END IF;
    RETURN jsonb_build_object('allowed', false, 'reason', 'original_instance_archived');
  END IF;
  IF v_instance.status IN ('paused', 'stopped', 'stopping') THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'original_instance_paused');
  END IF;
  -- Always honor the replacement runner's newest trusted action if one exists.
  SELECT * INTO v_action FROM public.instance_logs
    WHERE instance_id = p_instance_id AND site_id = v_requirement.site_id
      AND log_type = 'user_action' AND trusted_user_action IS TRUE
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF FOUND THEN
    IF COALESCE(v_action.details->>'status', '') NOT IN ('completed', 'failed') THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'assistant_action_not_finished');
    END IF;
    RETURN jsonb_build_object('allowed', true);
  END IF;
  IF v_requirement.metadata->>'assistant_origin_instance_id' IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.requirement_archived_runner_reassignments AS receipt
      WHERE receipt.requirement_id = p_requirement_id AND receipt.site_id = v_requirement.site_id
        AND receipt.instance_id = p_instance_id
        AND receipt.instance_id::text = v_requirement.metadata->>'runner_instance_id'
        AND CASE WHEN v_requirement.metadata->>'requirement_execution_generation' ~ '^[0-9]{1,10}$'
          THEN (v_requirement.metadata->>'requirement_execution_generation')::bigint
            BETWEEN receipt.execution_generation AND 2147483647
          ELSE false END) THEN
      RETURN jsonb_build_object('allowed', true);
    END IF;
    RETURN jsonb_build_object('allowed', false, 'reason', 'assistant_handoff_not_confirmed');
  END IF;
  RETURN jsonb_build_object('allowed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.inspect_requirement_assistant_handoff(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_requirement_assistant_handoff(uuid, uuid) TO service_role;

-- Preserve the existing admission trigger and requirement-before-instance lock
-- order. SHARE serializes trusted admission with archive/replacement's row lock;
-- an archived historical ID cannot admit a fresh interactive executor.
CREATE OR REPLACE FUNCTION public.guard_requirement_assistant_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_requirement public.requirements%ROWTYPE;
  v_archived boolean;
BEGIN
  IF NEW.log_type <> 'user_action' OR NEW.trusted_user_action IS DISTINCT FROM true THEN RETURN NEW; END IF;
  FOR v_requirement IN
    SELECT * FROM public.requirements WHERE site_id = NEW.site_id
      AND metadata->>'runner_instance_id' = NEW.instance_id::text
      -- Admission belongs to the current owner, including cron-created and
      -- replacement runners that never had an assistant origin.
    ORDER BY id FOR UPDATE
  LOOP
    IF v_requirement.cron_lock_active IS TRUE AND v_requirement.cron_lock_run_id IS NOT NULL
      AND v_requirement.cron_lock_expires_at > clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'requirement_execution_busy';
    END IF;
  END LOOP;
  SELECT is_archived INTO v_archived FROM public.remote_instances
    WHERE id = NEW.instance_id AND site_id = NEW.site_id FOR SHARE;
  IF v_archived IS TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'original_instance_archived';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_requirement_assistant_admission()
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve assistant/same-instance admission and do not activate a paused plan.
-- The base still owns the global-capacity-before-requirement lock order.
CREATE OR REPLACE FUNCTION public.activate_requirement_cron_run(
  p_requirement_id uuid, p_run_id text, p_max_concurrent integer, p_ttl_seconds integer DEFAULT 7200
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_result jsonb;
  v_requirement public.requirements%ROWTYPE;
  v_runner text;
BEGIN
  v_result := public.activate_requirement_cron_run_before_assistant_handoff(
    p_requirement_id, p_run_id, p_max_concurrent, p_ttl_seconds);
  IF v_result->>'state' <> 'active' THEN RETURN v_result; END IF;
  SELECT * INTO v_requirement FROM public.requirements WHERE id = p_requirement_id;
  v_runner := v_requirement.metadata->>'runner_instance_id';
  IF COALESCE(v_requirement.status, '') NOT IN ('backlog', 'in-progress')
    OR v_requirement.cron_lock_expires_at <= clock_timestamp()
    OR COALESCE((SELECT plan.status FROM public.instance_plans AS plan
      WHERE plan.instance_id::text = v_runner
        AND plan.status IN ('pending', 'in_progress', 'active', 'paused')
      ORDER BY plan.created_at DESC, plan.id DESC LIMIT 1), '') = 'paused'
    OR (v_runner IS NOT NULL AND EXISTS (SELECT 1 FROM public.requirements AS other
      WHERE other.id <> p_requirement_id AND other.metadata->>'runner_instance_id' = v_runner
        AND other.cron_lock_active IS TRUE AND other.cron_lock_run_id IS NOT NULL
        AND other.cron_lock_expires_at > clock_timestamp()))
    OR (v_runner IS NOT NULL AND NOT (public.inspect_requirement_assistant_handoff(
      p_requirement_id, v_runner::uuid)->>'allowed')::boolean)
  THEN
    UPDATE public.requirements SET cron_lock_active = false
      WHERE id = p_requirement_id AND cron_lock_run_id = p_run_id;
    RETURN jsonb_build_object('state', 'stale');
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.activate_requirement_cron_run(uuid, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_requirement_cron_run(uuid, text, integer, integer) TO service_role;
-- Archived+paused instances may be claimed for replacement, not resumed.
-- The latest-plan pause guard and existing healthy lease behavior are unchanged.
-- Use the fixed rollout cutoff, not a moving current-month window.
-- September requirements must remain eligible in October and later months.
-- Preserve existing leases, capacity, pause guards and ownership fencing.
-- This changes selection only: no requirement timestamps/statuses are rewritten.

CREATE OR REPLACE FUNCTION public.claim_requirement_cron_candidates(
  p_max_concurrent integer,
  p_ttl_seconds integer DEFAULT 7200,
  p_excluded_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
  v_scope_start CONSTANT timestamptz := '2026-09-01 00:00:00+00'::timestamptz;
  v_active integer;
  v_slots integer;
  v_requirement public.requirements%ROWTYPE;
  v_run_id text;
  v_expires_at timestamptz;
  v_stale_cutoff timestamptz := v_now - interval '30 minutes';
BEGIN
  IF p_max_concurrent IS NULL
    OR p_max_concurrent < 1
    OR p_max_concurrent > 100
  THEN
    RAISE EXCEPTION 'Maximum concurrent requirement runs must be between 1 and 100';
  END IF;
  IF p_ttl_seconds IS NULL
    OR p_ttl_seconds < 60
    OR p_ttl_seconds > 86400
  THEN
    RAISE EXCEPTION 'Requirement lock TTL must be between 60 and 86400 seconds';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('requirement-cron-global-capacity', 0)
  );

  -- Reclaim abandoned or frozen leases, but never evict a healthy workflow
  -- just because its creation date is outside the claim window.
  UPDATE public.requirements AS requirement
  SET
    cron_lock_expires_at = NULL,
    cron_lock_run_id = NULL,
    cron_lock_active = false,
    metadata = COALESCE(requirement.metadata, '{}'::jsonb) || jsonb_build_object(
      'requirement_execution_generation', CASE
        WHEN COALESCE(requirement.metadata->>'requirement_execution_generation', '') ~ '^[0-9]{1,9}$'
          THEN (requirement.metadata->>'requirement_execution_generation')::integer + 1
        ELSE 1 END
    )
  WHERE requirement.cron_lock_run_id IS NOT NULL
    AND (
      requirement.cron_lock_expires_at IS NULL
      OR requirement.cron_lock_expires_at <= v_now
      OR COALESCE(requirement.status, '') NOT IN ('backlog', 'in-progress')
      OR EXISTS (
        SELECT 1
        FROM public.remote_instances AS instance
        WHERE instance.id::text =
          requirement.metadata->>'runner_instance_id'
          AND instance.status = 'paused'
          AND instance.is_archived IS NOT TRUE
      )
      OR COALESCE((
        SELECT plan.status
        FROM public.instance_plans AS plan
        WHERE plan.instance_id::text =
          requirement.metadata->>'runner_instance_id'
          AND plan.status IN ('pending', 'in_progress', 'active', 'paused')
        ORDER BY plan.created_at DESC, plan.id DESC
        LIMIT 1
      ), '') = 'paused'
      OR (
        requirement.cron_lock_expires_at < v_now + pg_catalog.make_interval(
          secs => GREATEST(p_ttl_seconds - 1800, 0)
        )
        AND GREATEST(
          COALESCE(requirement.updated_at, '-infinity'::timestamptz),
          COALESCE((
            SELECT max(status.updated_at)
            FROM public.requirement_status AS status
            WHERE status.requirement_id = requirement.id
          ), '-infinity'::timestamptz),
          COALESCE((
            SELECT max(plan.updated_at)
            FROM public.instance_plans AS plan
            WHERE plan.metadata->>'requirement_id' = requirement.id::text
              OR plan.instance_id::text =
                requirement.metadata->>'runner_instance_id'
          ), '-infinity'::timestamptz)
        ) < v_stale_cutoff
      )
    );

  SELECT count(*)::integer
  INTO v_active
  FROM public.requirements
  WHERE cron_lock_expires_at > v_now
    AND cron_lock_active = true;

  v_slots := GREATEST(0, p_max_concurrent - v_active);
  IF v_slots = 0 THEN
    RETURN NEXT jsonb_build_object(
      'state', 'capacity_full',
      'active_runs', v_active
    );
    RETURN;
  END IF;

  v_expires_at := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);

  FOR v_requirement IN
    SELECT requirement.*
    FROM public.requirements AS requirement
    WHERE requirement.created_at >= v_scope_start
      AND requirement.updated_at >= v_scope_start
      AND (
        requirement.status IN ('backlog', 'in-progress')
        OR (
          requirement.status = 'blocked'
          AND requirement.cron IS NOT NULL
        )
        OR (
          requirement.status IN ('on-review', 'done', 'cancelled')
          AND requirement.cron IS NOT NULL
        )
      )
      AND (
        requirement.cron_lock_expires_at IS NULL
        OR requirement.cron_lock_expires_at <= v_now
      )
      AND NOT (
        requirement.id = ANY(COALESCE(p_excluded_ids, '{}'::uuid[]))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.remote_instances AS instance
        WHERE instance.id::text =
          requirement.metadata->>'runner_instance_id'
          AND instance.status = 'paused'
          AND instance.is_archived IS NOT TRUE
      )
      AND COALESCE((
        SELECT plan.status
        FROM public.instance_plans AS plan
        WHERE plan.instance_id::text =
          requirement.metadata->>'runner_instance_id'
          AND plan.status IN ('pending', 'in_progress', 'active', 'paused')
        ORDER BY plan.created_at DESC, plan.id DESC
        LIMIT 1
      ), '') <> 'paused'
    ORDER BY requirement.updated_at ASC NULLS FIRST, requirement.id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  LOOP
    v_run_id := 'cron-' || pg_catalog.gen_random_uuid()::text;

    UPDATE public.requirements AS requirement
    SET
      cron_lock_expires_at = v_expires_at,
      cron_lock_run_id = v_run_id,
      cron_lock_active = false
    WHERE requirement.id = v_requirement.id
    RETURNING requirement.* INTO v_requirement;

    RETURN NEXT jsonb_build_object(
      'state', 'claimed',
      'requirement', to_jsonb(v_requirement),
      'run_id', v_run_id,
      'expires_at', v_expires_at
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_requirement_cron_candidates(
  integer,
  integer,
  uuid[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_requirement_cron_candidates(
  integer,
  integer,
  uuid[]
) TO service_role;
COMMIT;
