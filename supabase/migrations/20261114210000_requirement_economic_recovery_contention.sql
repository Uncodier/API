BEGIN;
SET LOCAL lock_timeout = '5s';

-- Full reviewed recovery definition; no catalog-text rewriting or guard changes.
CREATE OR REPLACE FUNCTION public.recheck_requirement_economic_pauses(p_excluded_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET lock_timeout = '50ms' AS $$
DECLARE candidate record; receipt public.requirement_economic_pauses%ROWTYPE;
  r public.requirements%ROWTYPE; h public.harness_requirement_runs%ROWTYPE;
  s public.harness_sessions%ROWTYPE; latest public.requirement_status%ROWTYPE;
  observation jsonb; renewal jsonb; available numeric; effective_budget numeric; credit_minimum numeric;
  command record; action public.instance_logs%ROWTYPE; owner public.remote_instances%ROWTYPE;
  patch jsonb; ready boolean; has_command boolean;
BEGIN
  -- Opportunistic recovery never waits for another scheduler's capacity fence.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('requirement-cron-global-capacity',0)) THEN RETURN; END IF;
  FOR candidate IN SELECT requirement_id FROM public.requirement_economic_pauses
    WHERE checked_at<=clock_timestamp()-interval '60 seconds'
      AND NOT(requirement_id=ANY(coalesce(p_excluded_ids,'{}'::uuid[])))
    ORDER BY checked_at,requirement_id LIMIT 100
  LOOP
    -- Every candidate lock/write, including checked_at, belongs to this
    -- subtransaction. A busy dependency rolls back progress and acquired locks;
    -- the durable receipt stays due for a later scheduler invocation.
    BEGIN
      SELECT * INTO r FROM public.requirements WHERE id=candidate.requirement_id FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN CONTINUE; END IF;
      SELECT * INTO h FROM public.harness_requirement_runs WHERE requirement_id=r.id FOR UPDATE NOWAIT;
      SELECT * INTO s FROM public.harness_sessions WHERE id=h.session_id FOR UPDATE NOWAIT;
      SELECT * INTO receipt FROM public.requirement_economic_pauses WHERE requirement_id=r.id FOR UPDATE NOWAIT;
      IF NOT FOUND THEN CONTINUE; END IF;
      UPDATE public.requirement_economic_pauses SET checked_at=clock_timestamp(),last_error_code=NULL WHERE requirement_id=r.id;
      IF public.requirement_pause_command_guard(r.id,receipt.requirement_guard) IS DISTINCT FROM true
        OR r.status<>'blocked' OR r.cron_lock_expires_at>clock_timestamp()
        OR h.session_id IS DISTINCT FROM receipt.session_id OR h.generation IS DISTINCT FROM receipt.generation
        OR h.site_id IS DISTINCT FROM r.site_id OR h.pause_reason IS DISTINCT FROM receipt.pause_reason
        OR h.next_run_at IS NOT NULL OR s.version IS DISTINCT FROM receipt.session_version
        OR s.lease_expires_at>clock_timestamp() THEN CONTINUE; END IF;
      SELECT * INTO latest FROM public.requirement_status WHERE requirement_id=r.id
        ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 1;
      IF latest.id IS DISTINCT FROM receipt.status_id OR to_jsonb(latest) IS DISTINCT FROM receipt.status_guard
        OR latest.cycle IS DISTINCT FROM 'agent:'||h.last_cycle_id THEN CONTINUE; END IF;
      IF EXISTS (SELECT 1 FROM public.harness_sessions cleanup WHERE cleanup.sandbox_cleanup_token IS NOT NULL AND (
        cleanup.id=h.session_id OR (cleanup.site_id=r.site_id AND cleanup.snapshot#>>'{request,requirementId}'=r.id::text)
        OR cleanup.sandbox_cleanup_resource=s.snapshot#>>'{workspace,id}')) THEN CONTINUE; END IF;
      IF s.id IS NOT NULL AND (s.site_id IS DISTINCT FROM r.site_id OR s.user_id IS DISTINCT FROM r.user_id
        OR (s.snapshot#>>'{request,requirementId}' IS NOT NULL AND s.snapshot#>>'{request,requirementId}'<>r.id::text)
        OR coalesce(s.snapshot->>'status','') NOT IN ('queued','running','paused')
        OR (s.snapshot->>'status'='paused' AND s.snapshot->>'reason' IS DISTINCT FROM h.pause_reason)
        OR s.snapshot ? 'pending' OR s.snapshot->'uncertainOperations' IS DISTINCT FROM '[]'::jsonb
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'messages') msg,
          jsonb_array_elements(coalesce(msg->'toolCalls','[]'::jsonb)) call
          WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'messages') result
            WHERE result->>'role'='tool' AND result->>'toolCallId'=call->>'id'))) THEN CONTINUE; END IF;
      -- Match command draining's UUID-ordered owner locks before checking the
      -- runner. A distinct origin cannot be paused/archived during recovery.
      ready:=true;
      FOR owner IN SELECT i.* FROM public.remote_instances i WHERE i.site_id=r.site_id
        AND i.id::text IN (r.metadata->>'runner_instance_id',r.metadata->>'assistant_origin_instance_id')
        ORDER BY i.id FOR UPDATE
      LOOP
        IF owner.is_archived IS TRUE OR owner.status IN ('paused','stopped','stopping','cancelled') THEN ready:=false; END IF;
      END LOOP;
      IF NOT ready OR public.agent_requirement_runner_allowed(r.id,(r.metadata->>'runner_instance_id')::uuid) IS DISTINCT FROM true THEN CONTINUE; END IF;
      IF EXISTS (SELECT 1 FROM public.instance_plans p WHERE p.site_id=r.site_id AND p.status='paused'
        AND (p.metadata->>'requirement_id'=r.id::text OR p.instance_id::text IN
          (r.metadata->>'runner_instance_id',r.metadata->>'assistant_origin_instance_id'))) THEN CONTINUE; END IF;
      IF EXISTS (SELECT 1 FROM public.harness_model_credit_reservations
        WHERE (requirement_id=r.id OR session_id=h.session_id) AND state IN ('reserved','dispatched','pending')) THEN CONTINUE; END IF;
      IF EXISTS (SELECT 1 FROM public.requirements other WHERE other.id<>r.id AND other.cron_lock_expires_at>clock_timestamp()
        AND (other.metadata->>'runner_instance_id'=r.metadata->>'runner_instance_id'
          OR other.metadata->>'assistant_origin_instance_id'=r.metadata->>'runner_instance_id')) THEN CONTINUE; END IF;
      -- Wait for the entire admitted pending chain. Never let a new revision
      -- leapfrog a running action or use a cancelled/paused action as consent.
      patch:='{}'::jsonb; ready:=true; has_command:=false;
      FOR command IN SELECT c.* FROM public.requirement_commands c
        WHERE c.requirement_id=r.id AND c.applied_at IS NULL ORDER BY c.revision FOR UPDATE
      LOOP
        SELECT * INTO action FROM public.instance_logs WHERE id=command.action_id FOR SHARE;
        IF NOT FOUND OR coalesce(action.details->>'status','') NOT IN ('completed','failed')
          OR action.trusted_user_action IS DISTINCT FROM true OR action.log_type IS DISTINCT FROM 'user_action'
          OR action.site_id IS DISTINCT FROM r.site_id THEN ready:=false; EXIT; END IF;
        patch:=patch||command.patch;
        has_command:=has_command OR action.created_at>=latest.updated_at;
      END LOOP;
      IF NOT ready OR (receipt.pause_reason IN ('turn_budget_exhausted','active_time_budget_exhausted') AND NOT has_command) THEN CONTINUE; END IF;
      observation:=public.requirement_budget_observation(r.id);
      effective_budget:=CASE WHEN patch ? 'budget' THEN (patch->>'budget')::numeric ELSE r.budget END;
      IF effective_budget IS NOT NULL AND (effective_budget<0 OR effective_budget::text IN ('NaN','Infinity','-Infinity')
        OR (observation->>'spent_usd')::numeric>=effective_budget) THEN CONTINUE; END IF;
      IF (observation->>'pending_model_reservations')::integer<>0 THEN CONTINUE; END IF;
      renewal:=public.renew_site_plan_credits(r.site_id);
      IF renewal->>'success' IS DISTINCT FROM 'true' THEN CONTINUE; END IF;
      SELECT credits_available INTO available FROM public.billing WHERE site_id=r.site_id FOR UPDATE;
      IF NOT FOUND OR available IS NULL OR available<=0 OR available::text IN ('NaN','Infinity','-Infinity') THEN CONTINUE; END IF;
      -- A positive balance can still be smaller than the rejected model hold.
      -- Require the trusted snapshot's actual admission amount to avoid reopening
      -- the same workspace every cron without any new usable funding.
      IF receipt.pause_reason='account_credits_exhausted' THEN
        IF jsonb_typeof(s.snapshot->'creditRecoveryMinimum') IS DISTINCT FROM 'number' THEN CONTINUE; END IF;
        credit_minimum:=(s.snapshot->>'creditRecoveryMinimum')::numeric;
        IF credit_minimum<=0 OR credit_minimum::text IN ('NaN','Infinity','-Infinity') OR available<credit_minimum THEN CONTINUE; END IF;
      END IF;
      IF s.id IS NOT NULL AND public.control_harness_session(s.id,r.site_id,'resume',NULL) IS NULL THEN CONTINUE; END IF;
      UPDATE public.requirements SET status='in-progress',updated_at=clock_timestamp() WHERE id=r.id;
      UPDATE public.harness_requirement_runs SET pause_reason=NULL,next_run_at=clock_timestamp() WHERE requirement_id=r.id;
      -- Apply the already authorized command atomically with recovery, including
      -- its budget, before any cycle can observe the old exhausted budget.
      IF patch<>'{}'::jsonb THEN
        PERFORM public.apply_recovered_requirement_commands(r.id,patch);
      END IF;
      INSERT INTO public.requirement_status(requirement_id,site_id,instance_id,stage,cycle,message)
        VALUES(r.id,r.site_id,(r.metadata->>'runner_instance_id')::uuid,'in-progress','economic-recovery:'||h.last_cycle_id,
          format('Recoverable pause %s reevaluated: %s USD spent, %s USD budget, %s account credits available. Existing session retained.',
            receipt.pause_reason,observation->>'spent_usd',coalesce(effective_budget::text,'unlimited'),available));
    EXCEPTION
      WHEN lock_not_available OR deadlock_detected THEN
        -- Do not attempt another write against the dependency that just blocked.
        NULL;
      WHEN OTHERS THEN
        -- Retain SQLSTATE-only diagnostics without letting that write block cron.
        BEGIN
          UPDATE public.requirement_economic_pauses SET last_error_code=SQLSTATE WHERE requirement_id=candidate.requirement_id;
        EXCEPTION WHEN lock_not_available OR deadlock_detected THEN NULL;
        END;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.recheck_requirement_economic_pauses(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
