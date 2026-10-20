-- Review/offline only. Do not revoke healthy worker leases or deploy before the
-- trusted host and agent scheduler use this interface. No recovery RPC is called.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.requirement_commands (
  requirement_id uuid NOT NULL REFERENCES public.requirements(id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES public.instance_logs(id) ON DELETE CASCADE,
  patch jsonb NOT NULL CHECK (jsonb_typeof(patch) = 'object'),
  revision bigint NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  PRIMARY KEY (requirement_id, action_id),
  UNIQUE (requirement_id, revision)
);
CREATE INDEX requirement_commands_pending_idx
  ON public.requirement_commands (requirement_id, revision) WHERE applied_at IS NULL;
COMMENT ON TABLE public.requirement_commands IS
  'Trusted host commands; original message and authorization provenance remain in instance_logs. Receipts are independent of command application.';
ALTER TABLE public.requirement_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY requirement_commands_service_role ON public.requirement_commands
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.requirement_commands FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.requirement_commands TO service_role;

CREATE FUNCTION public.submit_requirement_command(
  p_requirement_id uuid, p_site_id uuid, p_user_id uuid, p_instance_id uuid,
  p_action_id uuid, p_patch jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r public.requirements%ROWTYPE;
  candidate public.requirements%ROWTYPE;
  source public.remote_instances%ROWTYPE;
  action public.instance_logs%ROWTYPE;
  command_revision bigint;
  entry record;
  column_required boolean;
  constraint_row record;
  constraint_valid boolean;
BEGIN
  IF p_requirement_id IS NULL OR p_site_id IS NULL OR p_user_id IS NULL
    OR p_instance_id IS NULL OR p_action_id IS NULL THEN
    RAISE EXCEPTION 'Invalid requirement command scope' USING ERRCODE = '22023';
  END IF;
  -- Keep the scheduler/recovery lock order: requirement, instance, action.
  SELECT * INTO r FROM public.requirements WHERE id = p_requirement_id FOR UPDATE;
  IF NOT FOUND OR r.site_id IS DISTINCT FROM p_site_id
    OR public.site_user_has_effective_access(p_site_id, p_user_id) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Requirement command authorization denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO source FROM public.remote_instances
    WHERE id = p_instance_id AND site_id = p_site_id FOR SHARE;
  IF NOT FOUND OR source.is_archived IS TRUE THEN
    RAISE EXCEPTION 'Requirement command authorization denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO action FROM public.instance_logs WHERE id = p_action_id FOR SHARE;
  IF NOT FOUND OR action.site_id IS DISTINCT FROM p_site_id
    OR action.user_id IS DISTINCT FROM p_user_id OR action.instance_id IS DISTINCT FROM p_instance_id
    OR action.log_type IS DISTINCT FROM 'user_action' OR action.trusted_user_action IS DISTINCT FROM true
    OR coalesce(action.details->>'status', '') NOT IN ('running', 'completed') THEN
    RAISE EXCEPTION 'Requirement command authorization denied' USING ERRCODE = '42501';
  END IF;
  -- An authenticated replay cannot replace the original patch, even after drain.
  IF EXISTS (SELECT 1 FROM public.requirement_commands
    WHERE requirement_id = r.id AND action_id = action.id) THEN
    RETURN jsonb_build_object('state', 'duplicate', 'requirement', to_jsonb(r),
      'authorization_action_id', action.id, 'runner_instance_id', r.metadata->>'runner_instance_id');
  END IF;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid requirement command patch' USING ERRCODE = '22023';
  END IF;
  FOR entry IN SELECT key, value FROM jsonb_each(p_patch) LOOP
    IF entry.key NOT IN ('title', 'description', 'instructions', 'priority', 'status',
      'completion_status', 'type', 'budget', 'cron', 'cycle') THEN
      RAISE EXCEPTION 'Invalid requirement command patch field' USING ERRCODE = '22023';
    END IF;
    -- Optional fields/types are read from the installed schema, not a stale copy.
    SELECT attnotnull INTO column_required FROM pg_attribute
      WHERE attrelid = 'public.requirements'::regclass AND attname = entry.key
        AND attnum > 0 AND NOT attisdropped;
    IF NOT FOUND OR (entry.value = 'null'::jsonb AND column_required)
      OR (entry.value <> 'null'::jsonb AND jsonb_typeof(entry.value) <>
        CASE WHEN entry.key = 'budget' THEN 'number' ELSE 'string' END) THEN
      RAISE EXCEPTION 'Invalid requirement command patch type' USING ERRCODE = '22023';
    END IF;
    IF (entry.key = 'priority' AND coalesce(entry.value #>> '{}', '') NOT IN ('high', 'medium', 'low'))
      OR (entry.key = 'status' AND coalesce(entry.value #>> '{}', '') NOT IN ('backlog', 'in-progress'))
      OR (entry.key = 'completion_status' AND entry.value IS DISTINCT FROM '"pending"'::jsonb) THEN
      RAISE EXCEPTION 'Invalid requirement command patch status' USING ERRCODE = '22023';
    END IF;
    IF entry.key IN ('title', 'instructions', 'type') AND coalesce(length(entry.value #>> '{}'), 0) = 0 THEN
      RAISE EXCEPTION 'Invalid requirement command patch empty field' USING ERRCODE = '22023';
    END IF;
    IF (entry.key = 'budget' AND entry.value <> 'null'::jsonb AND (entry.value #>> '{}')::numeric < 0)
      OR (entry.value <> 'null'::jsonb AND entry.key <> 'budget' AND length(entry.value #>> '{}') >
        CASE entry.key WHEN 'title' THEN 300 WHEN 'description' THEN 24000
          WHEN 'instructions' THEN 48000 WHEN 'type' THEN 100 ELSE 200 END) THEN
      RAISE EXCEPTION 'Invalid requirement command patch size or budget' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  -- Use the actual composite type (including enums/numeric constraints) and
  -- CHECK constraints without temporarily updating the requirement or triggers.
  candidate := jsonb_populate_record(r, p_patch);
  FOR constraint_row IN SELECT pg_get_expr(conbin, conrelid) expression
    FROM pg_constraint WHERE conrelid = 'public.requirements'::regclass AND contype = 'c'
  LOOP
    EXECUTE 'SELECT (' || constraint_row.expression || ') FROM (SELECT ($1::public.requirements).*) checked'
      INTO constraint_valid USING candidate;
    IF constraint_valid IS FALSE THEN
      RAISE EXCEPTION 'Invalid requirement command patch constraint' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  SELECT receipt.revision INTO command_revision FROM public.requirement_user_action_receipts receipt
    WHERE receipt.requirement_id = r.id AND receipt.action_id = action.id;
  IF NOT FOUND THEN
    command_revision := r.external_user_action_revision + 1;
    INSERT INTO public.requirement_user_action_receipts(requirement_id, action_id, action_created_at, revision)
      VALUES (r.id, action.id, action.created_at, command_revision);
    UPDATE public.requirements SET external_user_action_revision = command_revision,
      last_external_user_action_id = action.id::text WHERE id = r.id RETURNING * INTO r;
  ELSIF EXISTS (SELECT 1 FROM public.requirement_commands command
    WHERE command.requirement_id = r.id AND command.revision > command_revision) THEN
    -- Recovery receipts are independent, but their first command admission must
    -- not slip behind any newer queued or applied command. The requirement lock
    -- serializes this frontier check with submissions and draining. Existing
    -- command duplicates already returned above and remain valid replays.
    RAISE EXCEPTION 'Stale requirement command receipt revision' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.requirement_commands(requirement_id, action_id, patch, revision)
    VALUES (r.id, action.id, p_patch, command_revision);
  RETURN jsonb_build_object('state', 'queued', 'requirement', to_jsonb(r),
    'authorization_action_id', action.id, 'runner_instance_id', r.metadata->>'runner_instance_id');
END;
$$;

-- The host computes the latest relevant backlog completion timestamp. A queued
-- command's receipt does not authorize a running old generation; only its safe
-- application boundary can do so. Legacy recovery-only receipts remain valid.
CREATE FUNCTION public.has_requirement_scope_authorization(p_requirement_id uuid, p_completed_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT p_requirement_id IS NOT NULL AND p_completed_at IS NOT NULL AND isfinite(p_completed_at)
    AND EXISTS (
      SELECT 1 FROM public.requirement_user_action_receipts receipt
      LEFT JOIN public.requirement_commands command
        ON command.requirement_id = receipt.requirement_id AND command.action_id = receipt.action_id
      WHERE receipt.requirement_id = p_requirement_id
        AND ((command.action_id IS NULL AND receipt.action_created_at >= p_completed_at)
          OR (command.applied_at IS NOT NULL AND command.applied_at >= p_completed_at))
    );
$$;

CREATE FUNCTION public.apply_pending_requirement_commands()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r public.requirements%ROWTYPE;
  mapping public.harness_requirement_runs%ROWTYPE;
  session public.harness_sessions%ROWTYPE;
  owner public.remote_instances%ROWTYPE;
  command record;
  patch jsonb;
  action_status text;
  applied_ids uuid[];
  assignments text;
  generation integer;
  t timestamptz := clock_timestamp();
BEGIN
  FOR r IN SELECT q.* FROM public.requirements q
    WHERE EXISTS (SELECT 1 FROM public.requirement_commands c WHERE c.requirement_id = q.id AND c.applied_at IS NULL)
      -- Unfinished prefixes do not consume the bounded ready-requirement budget
      -- and starve other requirements. Recheck/lock the action inside the loop.
      AND (SELECT a.details->>'status' FROM public.requirement_commands c
        JOIN public.instance_logs a ON a.id = c.action_id
        WHERE c.requirement_id = q.id AND c.applied_at IS NULL ORDER BY c.revision LIMIT 1) IN ('completed', 'failed')
      -- Even an inactive claim with an unexpired timestamp still owns its lease.
      AND (q.cron_lock_expires_at IS NULL OR q.cron_lock_expires_at <= t)
      AND q.status NOT IN ('cancelled', 'canceled')
      AND (q.metadata IS NULL OR jsonb_typeof(q.metadata) = 'object')
      AND NOT coalesce(q.metadata ? 'execution_hold', false)
      AND coalesce(q.metadata->>'user_paused', 'false') <> 'true'
      AND coalesce(q.metadata->>'customer_paused', 'false') <> 'true'
      AND coalesce(q.metadata->>'cron_paused', 'false') <> 'true'
      AND NOT EXISTS (SELECT 1 FROM public.harness_requirement_runs h
        JOIN public.harness_sessions s ON s.id = h.session_id
        WHERE h.requirement_id = q.id AND (s.lease_expires_at > t OR s.snapshot->>'status' IN ('paused', 'cancelled')))
      AND NOT EXISTS (SELECT 1 FROM public.remote_instances i WHERE i.site_id = q.site_id
        AND i.id::text IN (q.metadata->>'runner_instance_id', q.metadata->>'assistant_origin_instance_id')
        AND i.status IN ('paused', 'stopped', 'stopping'))
      AND NOT EXISTS (SELECT 1 FROM public.instance_plans p WHERE p.site_id = q.site_id AND p.status = 'paused'
        AND (p.metadata->>'requirement_id' = q.id::text OR p.instance_id::text IN
          (q.metadata->>'runner_instance_id', q.metadata->>'assistant_origin_instance_id')))
    ORDER BY q.updated_at, q.id LIMIT 100 FOR UPDATE OF q SKIP LOCKED
  LOOP
    SELECT * INTO mapping FROM public.harness_requirement_runs WHERE requirement_id = r.id FOR UPDATE;
    IF FOUND THEN
      SELECT * INTO session FROM public.harness_sessions WHERE id = mapping.session_id FOR UPDATE;
      IF FOUND AND (session.lease_expires_at > clock_timestamp() OR session.snapshot->>'status' IN ('paused', 'cancelled')) THEN CONTINUE; END IF;
    END IF;
    -- Preserve explicit owner/plan pauses in addition to requirement holds. Lock
    -- existing owners like the scheduler; neither command source nor a new owner
    -- is bound here. Missing owners remain the scheduler's admission decision.
    owner := NULL;
    FOR owner IN SELECT i.* FROM public.remote_instances i
      WHERE i.site_id = r.site_id AND i.id::text IN
        (r.metadata->>'runner_instance_id', r.metadata->>'assistant_origin_instance_id')
      ORDER BY i.id FOR UPDATE
    LOOP
      IF owner.status IN ('paused', 'stopped', 'stopping') THEN EXIT; END IF;
    END LOOP;
    IF owner.status IN ('paused', 'stopped', 'stopping') THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.instance_plans p WHERE p.site_id = r.site_id AND p.status = 'paused'
      AND (p.metadata->>'requirement_id' = r.id::text OR p.instance_id::text IN
        (r.metadata->>'runner_instance_id', r.metadata->>'assistant_origin_instance_id'))) THEN CONTINUE; END IF;
    generation := 0;
    IF r.metadata ? 'requirement_execution_generation' THEN
      IF coalesce(r.metadata->>'requirement_execution_generation', '') !~ '^[0-9]{1,9}$' THEN CONTINUE; END IF;
      generation := (r.metadata->>'requirement_execution_generation')::integer;
      IF generation >= 999999999 THEN CONTINUE; END IF;
    END IF;
    patch := '{}'::jsonb;
    applied_ids := '{}'::uuid[];
    FOR command IN SELECT c.* FROM public.requirement_commands c
      WHERE c.requirement_id = r.id AND c.applied_at IS NULL ORDER BY c.revision FOR UPDATE
    LOOP
      SELECT a.details->>'status' INTO action_status FROM public.instance_logs a
        WHERE a.id = command.action_id FOR SHARE;
      -- Failed host actions are quiescent; running/paused/cancelled are not.
      -- Never allow a newer patch to leapfrog an unfinished older revision.
      IF NOT FOUND OR coalesce(action_status, '') NOT IN ('completed', 'failed') THEN EXIT; END IF;
      patch := patch || command.patch;
      applied_ids := array_append(applied_ids, command.action_id);
    END LOOP;
    IF cardinality(applied_ids) = 0 THEN CONTINUE; END IF;
    -- Exactly one atomic update and generation increment for this requirement's
    -- ready prefix. No ownership, backlog, plans, holds, sandbox or budget resets.
    SELECT string_agg(format('%I = (jsonb_populate_record(q, $1)).%I', key, key), ', ' ORDER BY key)
      INTO assignments FROM jsonb_object_keys(patch - ARRAY['status', 'completion_status']) key;
    IF assignments IS NOT NULL THEN assignments := assignments || ', '; ELSE assignments := ''; END IF;
    EXECUTE 'UPDATE public.requirements q SET ' || assignments ||
      'status = ''in-progress'', completion_status = ''pending'', updated_at = $2, ' ||
      'metadata = coalesce(q.metadata, ''{}''::jsonb) || jsonb_build_object(''requirement_execution_generation'', $3), ' ||
      'cron_lock_run_id = NULL, cron_lock_expires_at = NULL, cron_lock_active = false WHERE q.id = $4'
      USING patch, clock_timestamp(), generation + 1, r.id;
    UPDATE public.requirement_commands SET applied_at = clock_timestamp()
      WHERE requirement_id = r.id AND action_id = ANY(applied_ids);
  END LOOP;
END;
$$;

ALTER FUNCTION public.claim_agent_requirement_run(uuid[], integer, integer, uuid[])
  RENAME TO claim_agent_requirement_run_before_commands;
CREATE FUNCTION public.claim_agent_requirement_run(
  p_excluded_ids uuid[], p_max_concurrent integer, p_ttl_seconds integer,
  p_scheduled_ids uuid[] DEFAULT '{}'::uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM public.apply_pending_requirement_commands();
  RETURN public.claim_agent_requirement_run_before_commands(p_excluded_ids, p_max_concurrent, p_ttl_seconds, p_scheduled_ids);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_requirement_command(uuid, uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.has_requirement_scope_authorization(uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_pending_requirement_commands() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_agent_requirement_run(uuid[], integer, integer, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_agent_requirement_run_before_commands(uuid[], integer, integer, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_requirement_command(uuid, uuid, uuid, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.has_requirement_scope_authorization(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_pending_requirement_commands() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_agent_requirement_run(uuid[], integer, integer, uuid[]) TO service_role;
COMMIT;