BEGIN;
SET LOCAL lock_timeout = '5s';

-- Observation only. In particular, do not call runner_allowed (which locks an
-- instance), renew credits, recheck pauses, apply commands, or control sessions.
-- The service caller must authorize p_site_id before invoking this private RPC.
CREATE FUNCTION public.inspect_requirement_commands(p_requirement_ids uuid[], p_site_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r public.requirements%ROWTYPE;
  h public.harness_requirement_runs%ROWTYPE;
  s public.harness_sessions%ROWTYPE;
  receipt public.requirement_economic_pauses%ROWTYPE;
  latest public.requirement_status%ROWTYPE;
  owner public.remote_instances%ROWTYPE;
  command record;
  owner_key text;
  owner_id text;
  action_status text;
  state text;
  reason text;
  retryable boolean;
  economic boolean;
  recent_command boolean;
  patch jsonb;
  observation jsonb;
  effective_budget numeric;
  spent numeric;
  available numeric;
  credit_minimum numeric;
  result jsonb := '{}'::jsonb;
  checked_at timestamptz := statement_timestamp();
BEGIN
  IF p_site_id IS NULL OR p_requirement_ids IS NULL OR cardinality(p_requirement_ids)>500 THEN
    RAISE EXCEPTION 'Invalid requirement diagnostic scope' USING ERRCODE='22023';
  END IF;

  -- Unknown IDs, NULL elements, and other tenants' IDs are omitted, not labeled.
  -- Repeated input IDs cannot duplicate work or bypass the input cardinality cap.
  FOR r IN SELECT q.* FROM public.requirements q
    WHERE q.site_id=p_site_id AND q.id=ANY(p_requirement_ids) ORDER BY q.id
  LOOP
    state := 'blocked'; reason := NULL;
    <<inspect>>
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM public.requirement_commands c WHERE c.requirement_id=r.id) THEN
        state := 'none'; EXIT inspect;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.requirement_commands c WHERE c.requirement_id=r.id AND c.applied_at IS NULL) THEN
        -- Applied means the patch was persisted, NOT that execution has started
        -- or will complete. Execution eligibility is deliberately not inferred.
        state := 'applied'; EXIT inspect;
      END IF;

      SELECT * INTO h FROM public.harness_requirement_runs WHERE requirement_id=r.id AND site_id=r.site_id;
      SELECT * INTO s FROM public.harness_sessions WHERE id=h.session_id AND site_id=r.site_id;
      SELECT * INTO receipt FROM public.requirement_economic_pauses WHERE requirement_id=r.id;
      economic := r.status='blocked' AND (receipt.requirement_id IS NOT NULL
        OR coalesce(h.pause_reason,'') IN
          ('token_budget_exhausted','account_credits_exhausted','turn_budget_exhausted','active_time_budget_exhausted')
        OR (coalesce(s.snapshot->>'status','')='paused' AND coalesce(s.snapshot->>'reason','') IN
          ('token_budget_exhausted','account_credits_exhausted','turn_budget_exhausted','active_time_budget_exhausted')));

      -- Ordinary application consumes a ready prefix. Economic recovery requires
      -- the entire admitted chain to be quiescent. Never use a later patch budget
      -- across an unfinished revision, or treat paused/cancelled as consent.
      patch := '{}'::jsonb; recent_command := false;
      FOR command IN SELECT c.patch, a.id AS action_id, a.details->>'status' AS action_status,
          a.created_at, a.trusted_user_action, a.log_type
        FROM public.requirement_commands c LEFT JOIN public.instance_logs a
          ON a.id=c.action_id AND a.site_id=r.site_id
        WHERE c.requirement_id=r.id AND c.applied_at IS NULL ORDER BY c.revision
      LOOP
        IF command.action_id IS NULL OR command.trusted_user_action IS DISTINCT FROM true
          OR command.log_type IS DISTINCT FROM 'user_action'
          OR coalesce(command.action_status,'') NOT IN ('completed','failed') THEN
          IF NOT economic AND patch<>'{}'::jsonb THEN EXIT; END IF;
          reason := CASE
            WHEN command.action_id IS NULL OR command.trusted_user_action IS DISTINCT FROM true
              OR command.log_type IS DISTINCT FROM 'user_action' THEN 'action_unavailable'
            WHEN command.action_status='paused' THEN 'action_paused'
            WHEN command.action_status IN ('cancelled','canceled') THEN 'action_cancelled'
            ELSE 'action_unfinished' END;
          EXIT inspect;
        END IF;
        patch := patch || command.patch;
        recent_command := recent_command OR coalesce(command.created_at >= (receipt.status_guard->>'updated_at')::timestamptz,false);
      END LOOP;

      IF r.status IN ('cancelled','canceled') THEN reason := 'requirement_cancelled'; EXIT inspect; END IF;
      IF r.metadata IS NOT NULL AND jsonb_typeof(r.metadata)<>'object' THEN
        reason := 'requirement_metadata_invalid'; EXIT inspect;
      END IF;
      IF r.metadata ? 'execution_hold' THEN reason := 'execution_hold'; EXIT inspect; END IF;
      IF coalesce(r.metadata->>'user_paused','false')='true'
        OR coalesce(r.metadata->>'customer_paused','false')='true'
        OR coalesce(r.metadata->>'cron_paused','false')='true' THEN
        reason := 'requirement_paused'; EXIT inspect;
      END IF;
      IF r.metadata ? 'requirement_execution_generation' AND
        (coalesce(r.metadata->>'requirement_execution_generation','') !~ '^[0-9]{1,9}$'
          OR r.metadata->>'requirement_execution_generation'='999999999') THEN
        reason := 'generation_invalid'; EXIT inspect;
      END IF;

      FOREACH owner_key IN ARRAY ARRAY['runner_instance_id','assistant_origin_instance_id'] LOOP
        owner_id := r.metadata->>owner_key;
        IF owner_id IS NULL THEN
          -- First-run infrastructure can be created by the scheduler. Recovery,
          -- unlike first-run scheduling, requires its original bound runner.
          IF economic AND owner_key='runner_instance_id' THEN reason := 'runner_missing'; EXIT inspect; END IF;
          CONTINUE;
        END IF;
        SELECT * INTO owner FROM public.remote_instances WHERE id::text=owner_id AND site_id=r.site_id;
        IF NOT FOUND THEN
          reason := CASE owner_key WHEN 'runner_instance_id' THEN 'runner_missing' ELSE 'origin_missing' END;
          EXIT inspect;
        END IF;
        IF owner.is_archived IS TRUE THEN
          reason := CASE owner_key WHEN 'runner_instance_id' THEN 'runner_archived' ELSE 'origin_archived' END;
          EXIT inspect;
        END IF;
        IF owner.status IN ('paused','stopped','stopping','cancelled','canceled') THEN
          reason := CASE owner_key WHEN 'runner_instance_id' THEN 'runner_paused' ELSE 'origin_paused' END;
          EXIT inspect;
        END IF;
        SELECT a.details->>'status' INTO action_status FROM public.instance_logs a
          WHERE a.instance_id=owner.id AND a.site_id=r.site_id AND a.log_type='user_action'
            AND a.trusted_user_action IS TRUE ORDER BY a.created_at DESC,a.id DESC LIMIT 1;
        IF (FOUND AND coalesce(action_status,'') NOT IN ('completed','failed'))
          OR (NOT FOUND AND owner_key='assistant_origin_instance_id') THEN
          reason := CASE owner_key WHEN 'runner_instance_id' THEN 'runner_action_unfinished' ELSE 'origin_action_unfinished' END;
          EXIT inspect;
        END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM public.instance_plans p WHERE p.site_id=r.site_id AND p.status='paused'
        AND (p.metadata->>'requirement_id'=r.id::text OR p.instance_id::text IN
          (r.metadata->>'runner_instance_id',r.metadata->>'assistant_origin_instance_id'))) THEN
        reason := 'plan_paused'; EXIT inspect;
      END IF;
      IF r.cron_lock_expires_at>checked_at THEN reason := 'cron_lease_active'; EXIT inspect; END IF;
      IF s.lease_expires_at>checked_at THEN reason := 'session_lease_active'; EXIT inspect; END IF;
      IF EXISTS (SELECT 1 FROM public.requirements other WHERE other.site_id=r.site_id AND other.id<>r.id
        AND other.cron_lock_expires_at>checked_at
        AND (other.metadata->>'runner_instance_id'=r.metadata->>'runner_instance_id'
          OR other.metadata->>'assistant_origin_instance_id'=r.metadata->>'runner_instance_id')) THEN
        reason := 'runner_lease_active'; EXIT inspect;
      END IF;
      IF s.snapshot->>'status' IN ('cancelled','canceled') THEN reason := 'session_cancelled'; EXIT inspect; END IF;
      IF s.snapshot->>'status'='paused' AND (NOT economic OR s.snapshot->>'reason' IS DISTINCT FROM h.pause_reason) THEN
        reason := 'session_paused'; EXIT inspect;
      END IF;
      IF h.pause_reason IN ('user_pause','user_paused','customer_paused','cron_paused')
        AND s.snapshot->>'status' IS DISTINCT FROM 'queued' THEN
        reason := 'requirement_paused'; EXIT inspect;
      END IF;

      IF economic THEN
        IF receipt.requirement_id IS NULL THEN reason := 'economic_provenance_unavailable'; EXIT inspect; END IF;
        -- Do not emit private SQLSTATE, stored guards, provider messages or data.
        IF receipt.last_error_code IS NOT NULL THEN reason := 'recovery_failed'; EXIT inspect; END IF;
        SELECT * INTO latest FROM public.requirement_status WHERE requirement_id=r.id AND site_id=r.site_id
          ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 1;
        IF public.requirement_pause_command_guard(r.id,receipt.requirement_guard) IS DISTINCT FROM true
          OR h.session_id IS DISTINCT FROM receipt.session_id OR h.generation IS DISTINCT FROM receipt.generation
          OR h.pause_reason IS DISTINCT FROM receipt.pause_reason OR h.next_run_at IS NOT NULL
          OR s.version IS DISTINCT FROM receipt.session_version
          OR latest.id IS DISTINCT FROM receipt.status_id OR to_jsonb(latest) IS DISTINCT FROM receipt.status_guard
          OR latest.cycle IS DISTINCT FROM 'agent:'||h.last_cycle_id
          OR (s.id IS NOT NULL AND (s.user_id IS DISTINCT FROM r.user_id
            OR (s.snapshot#>>'{request,requirementId}' IS NOT NULL AND s.snapshot#>>'{request,requirementId}'<>r.id::text)
            OR coalesce(s.snapshot->>'status','') NOT IN ('queued','running','paused'))) THEN
          reason := 'economic_provenance_mismatch'; EXIT inspect;
        END IF;
        IF receipt.pause_reason IN ('turn_budget_exhausted','active_time_budget_exhausted') AND NOT recent_command THEN
          reason := 'recovery_command_required'; EXIT inspect;
        END IF;
      END IF;
      -- The ordinary drainer cannot bypass a durable blocked mapping pause,
      -- including when its session is absent. Explicit/manual pauses above win.
      IF NOT economic AND r.status='blocked' AND h.pause_reason IS NOT NULL
        AND s.snapshot->>'status' IS DISTINCT FROM 'queued' THEN
        reason := 'recovery_required'; EXIT inspect;
      END IF;

      IF EXISTS (SELECT 1 FROM public.harness_sessions cleanup WHERE cleanup.site_id=r.site_id
        AND cleanup.sandbox_cleanup_token IS NOT NULL AND (cleanup.id=h.session_id
          OR cleanup.snapshot#>>'{request,requirementId}'=r.id::text
          OR cleanup.sandbox_cleanup_resource=s.snapshot#>>'{workspace,id}')) THEN
        reason := 'cleanup_pending'; EXIT inspect;
      END IF;
      IF s.id IS NOT NULL AND (s.snapshot ? 'pending'
        OR ((economic OR s.snapshot ? 'uncertainOperations') AND s.snapshot->'uncertainOperations' IS DISTINCT FROM '[]'::jsonb)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'messages') msg,
          jsonb_array_elements(coalesce(msg->'toolCalls','[]'::jsonb)) call
          WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'messages') tool_result
            WHERE tool_result->>'role'='tool' AND tool_result->>'toolCallId'=call->>'id'))) THEN
        reason := 'effects_pending'; EXIT inspect;
      END IF;
      IF EXISTS (SELECT 1 FROM public.harness_model_credit_reservations m WHERE m.site_id=r.site_id
        AND (m.requirement_id=r.id OR m.session_id=h.session_id) AND m.state IN ('reserved','dispatched','pending')) THEN
        reason := 'model_reservation_pending'; EXIT inspect;
      END IF;

      effective_budget := CASE WHEN patch ? 'budget' THEN (patch->>'budget')::numeric ELSE r.budget END;
      IF effective_budget IS NOT NULL THEN
        IF effective_budget<0 OR effective_budget::text IN ('NaN','Infinity','-Infinity') THEN
          reason := 'budget_invalid'; EXIT inspect;
        END IF;
        IF effective_budget=0 THEN reason := 'budget_exhausted'; EXIT inspect; END IF;
        -- NULL is unlimited, never zero. Aggregate history only for a finite
        -- positive effective cap, after cheaper blockers, and never reserve it.
        BEGIN
          observation := public.requirement_budget_observation(r.id);
          spent := (observation->>'spent_usd')::numeric;
          IF spent IS NULL OR spent::text IN ('NaN','Infinity','-Infinity') THEN
            reason := 'budget_observation_unavailable'; EXIT inspect;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          reason := 'budget_observation_unavailable'; EXIT inspect;
        END;
        IF spent>=effective_budget THEN reason := 'budget_exhausted'; EXIT inspect; END IF;
      END IF;
      SELECT credits_available INTO available FROM public.billing WHERE site_id=r.site_id;
      IF NOT FOUND OR available IS NULL OR available::text IN ('NaN','Infinity','-Infinity') THEN
        reason := 'credits_unavailable'; EXIT inspect;
      END IF;
      IF available<=0 THEN reason := 'credits_exhausted'; EXIT inspect; END IF;
      IF economic AND h.pause_reason='account_credits_exhausted' THEN
        IF jsonb_typeof(s.snapshot->'creditRecoveryMinimum') IS DISTINCT FROM 'number' THEN
          reason := 'credit_admission_evidence_unavailable'; EXIT inspect;
        END IF;
        credit_minimum:=(s.snapshot->>'creditRecoveryMinimum')::numeric;
        IF credit_minimum<=0 OR credit_minimum::text IN ('NaN','Infinity','-Infinity') THEN
          reason := 'credit_admission_evidence_unavailable'; EXIT inspect;
        END IF;
        IF available<credit_minimum THEN reason := 'credits_insufficient_for_reservation'; EXIT inspect; END IF;
      END IF;
      state := 'queued'; reason := 'waiting_scheduler';
    EXCEPTION WHEN OTHERS THEN
      -- A malformed legacy row or unavailable observation must not fail the
      -- other tenant-scoped rows or disclose database/provider exception text.
      state := 'blocked'; reason := 'diagnostic_unavailable';
    END inspect;
    -- Retryable means a later read may observe progress, not permission to
    -- resubmit a command, retry a tool effect, resume a session, or start work.
    retryable := coalesce(reason=ANY(ARRAY['waiting_scheduler','action_unfinished',
      'runner_action_unfinished','origin_action_unfinished','cron_lease_active',
      'session_lease_active','runner_lease_active','cleanup_pending','effects_pending',
      'model_reservation_pending','recovery_failed','budget_observation_unavailable',
      'credits_unavailable','diagnostic_unavailable']),false);
    result := result || jsonb_build_object(r.id::text,jsonb_build_object(
      'state',state,'reason',reason,'retryable',retryable,'checked_at',checked_at));
  END LOOP;
  RETURN result;
END;
$$;

COMMENT ON FUNCTION public.inspect_requirement_commands(uuid[],uuid) IS
  'Read-only site-scoped command receipt/eligibility snapshot, max 500 IDs. Applied is not executed; queued is not a guarantee. No credit renewal, leases, recovery or mutations. Retryable refers only to reinspection.';
REVOKE ALL ON FUNCTION public.inspect_requirement_commands(uuid[],uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.inspect_requirement_commands(uuid[],uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;