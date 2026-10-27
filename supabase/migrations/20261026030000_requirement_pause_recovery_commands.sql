BEGIN;
SET LOCAL lock_timeout = '5s';

-- Keep the original private provenance and all quiescence fences. Expand only
-- classified pre-dispatch credit stops and retired limits with a real command.
ALTER TABLE public.requirement_economic_pauses ADD COLUMN pause_reason text NOT NULL DEFAULT 'token_budget_exhausted';

CREATE OR REPLACE FUNCTION public.capture_requirement_economic_pause(p_status_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE st public.requirement_status%ROWTYPE; r public.requirements%ROWTYPE;
  h public.harness_requirement_runs%ROWTYPE; s public.harness_sessions%ROWTYPE;
BEGIN
  SELECT * INTO st FROM public.requirement_status WHERE id=p_status_id;
  IF NOT FOUND OR st.stage<>'blocked' THEN RETURN; END IF;
  SELECT * INTO r FROM public.requirements WHERE id=st.requirement_id;
  SELECT * INTO h FROM public.harness_requirement_runs WHERE requirement_id=r.id;
  IF NOT FOUND OR r.status<>'blocked' OR st.site_id IS DISTINCT FROM r.site_id
    OR h.site_id IS DISTINCT FROM r.site_id OR st.cycle IS DISTINCT FROM 'agent:'||h.last_cycle_id
    OR st.instance_id::text IS DISTINCT FROM r.metadata->>'runner_instance_id'
    OR coalesce(h.pause_reason,'') NOT IN ('token_budget_exhausted','account_credits_exhausted',
      'turn_budget_exhausted','active_time_budget_exhausted') OR h.next_run_at IS NOT NULL
    OR h.generation::text IS DISTINCT FROM r.metadata->>'requirement_execution_generation' THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.requirements q
    JOIN public.harness_requirement_runs m ON m.requirement_id=q.id
    JOIN public.requirement_status status ON status.id=st.id
    WHERE q.id=r.id AND q.xmin=m.xmin AND q.xmin=status.xmin) THEN RETURN; END IF;
  SELECT * INTO s FROM public.harness_sessions WHERE id=h.session_id;
  IF FOUND AND (s.site_id IS DISTINCT FROM r.site_id OR s.user_id IS DISTINCT FROM r.user_id
    OR coalesce(s.snapshot->>'status','') NOT IN ('queued','running','paused')
    OR (s.snapshot->>'status'='paused' AND s.snapshot->>'reason' IS DISTINCT FROM h.pause_reason)) THEN RETURN; END IF;
  INSERT INTO public.requirement_economic_pauses(requirement_id,status_id,session_id,generation,
    requirement_guard,status_guard,session_version,pause_reason)
    VALUES(r.id,st.id,h.session_id,h.generation,to_jsonb(r)-ARRAY['budget','updated_at'],to_jsonb(st),s.version,h.pause_reason)
    ON CONFLICT(requirement_id) DO UPDATE SET status_id=EXCLUDED.status_id,session_id=EXCLUDED.session_id,
      generation=EXCLUDED.generation,requirement_guard=EXCLUDED.requirement_guard,status_guard=EXCLUDED.status_guard,
      session_version=EXCLUDED.session_version,pause_reason=EXCLUDED.pause_reason,last_error_code=NULL,checked_at='-infinity';
END;
$$;

-- Receipt fields are NOT ignored globally. Only a complete, still-pending chain
-- admitted through submit_requirement_command may explain their exact changes.
CREATE FUNCTION public.requirement_pause_command_guard(p_id uuid,p_guard jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; baseline bigint; count_commands bigint;
BEGIN
  SELECT * INTO r FROM public.requirements WHERE id=p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF to_jsonb(r)-ARRAY['budget','updated_at'] = p_guard THEN RETURN true; END IF;
  IF to_jsonb(r)-ARRAY['budget','updated_at','external_user_action_revision','last_external_user_action_id']
    IS DISTINCT FROM p_guard-ARRAY['external_user_action_revision','last_external_user_action_id'] THEN RETURN false; END IF;
  baseline:=(p_guard->>'external_user_action_revision')::bigint;
  IF baseline IS NULL OR r.external_user_action_revision<=baseline THEN RETURN false; END IF;
  SELECT count(*) INTO count_commands FROM public.requirement_commands c
    JOIN public.requirement_user_action_receipts receipt ON receipt.requirement_id=c.requirement_id
      AND receipt.action_id=c.action_id AND receipt.revision=c.revision
    JOIN public.instance_logs a ON a.id=c.action_id AND a.site_id=r.site_id
    WHERE c.requirement_id=r.id AND c.applied_at IS NULL AND c.revision>baseline
      AND c.revision<=r.external_user_action_revision AND a.log_type='user_action' AND a.trusted_user_action IS TRUE;
  RETURN count_commands=r.external_user_action_revision-baseline AND EXISTS (
    SELECT 1 FROM public.requirement_commands c WHERE c.requirement_id=r.id
      AND c.revision=r.external_user_action_revision AND c.action_id::text=r.last_external_user_action_id
      AND c.applied_at IS NULL);
END;
$$;

-- Recovery already owns requirement/session locks and has checked the original
-- command drainer's guards. Apply only this row, not an unrelated global batch.
CREATE FUNCTION public.apply_recovered_requirement_commands(p_id uuid,p_patch jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE assignments text; generation integer;
BEGIN
  SELECT (metadata->>'requirement_execution_generation')::integer INTO generation
    FROM public.requirements WHERE id=p_id FOR UPDATE;
  IF generation IS NULL OR generation<0 OR generation>=999999999 THEN
    RAISE EXCEPTION 'Invalid recovery generation' USING ERRCODE='22023';
  END IF;
  SELECT string_agg(format('%I = (jsonb_populate_record(q, $1)).%I',key,key),', ' ORDER BY key)
    INTO assignments FROM jsonb_object_keys(p_patch-ARRAY['status','completion_status']) key;
  IF assignments IS NOT NULL THEN assignments:=assignments||', '; ELSE assignments:=''; END IF;
  EXECUTE 'UPDATE public.requirements q SET '||assignments||
    'status = ''in-progress'', completion_status = ''pending'', updated_at = clock_timestamp(), '||
    'metadata = coalesce(q.metadata, ''{}''::jsonb) || jsonb_build_object(''requirement_execution_generation'', $2), '||
    'cron_lock_run_id = NULL, cron_lock_expires_at = NULL, cron_lock_active = false WHERE q.id = $3'
    USING p_patch,generation+1,p_id;
  UPDATE public.requirement_commands SET applied_at=clock_timestamp() WHERE requirement_id=p_id AND applied_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.recheck_requirement_economic_pauses(p_excluded_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE candidate record; receipt public.requirement_economic_pauses%ROWTYPE;
  r public.requirements%ROWTYPE; h public.harness_requirement_runs%ROWTYPE;
  s public.harness_sessions%ROWTYPE; latest public.requirement_status%ROWTYPE;
  observation jsonb; renewal jsonb; available numeric; effective_budget numeric; credit_minimum numeric;
  command record; action public.instance_logs%ROWTYPE; owner public.remote_instances%ROWTYPE;
  patch jsonb; ready boolean; has_command boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('requirement-cron-global-capacity',0));
  FOR candidate IN SELECT requirement_id FROM public.requirement_economic_pauses
    WHERE checked_at<=clock_timestamp()-interval '60 seconds'
      AND NOT(requirement_id=ANY(coalesce(p_excluded_ids,'{}'::uuid[])))
    ORDER BY checked_at,requirement_id LIMIT 100
  LOOP
    SELECT * INTO r FROM public.requirements WHERE id=candidate.requirement_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO h FROM public.harness_requirement_runs WHERE requirement_id=r.id FOR UPDATE;
    SELECT * INTO s FROM public.harness_sessions WHERE id=h.session_id FOR UPDATE;
    SELECT * INTO receipt FROM public.requirement_economic_pauses WHERE requirement_id=r.id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    UPDATE public.requirement_economic_pauses SET checked_at=clock_timestamp(),last_error_code=NULL WHERE requirement_id=r.id;
    BEGIN
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
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.requirement_economic_pauses SET last_error_code=SQLSTATE WHERE requirement_id=r.id;
    END;
  END LOOP;
END;
$$;

-- Import only intact historical retired-limit receipts, never infer permission
-- from free-form reconciliation errors or overwrite existing provenance.
DO $$ DECLARE entry record; BEGIN
  FOR entry IN SELECT last_status.id FROM public.requirements r
    JOIN public.harness_requirement_runs h ON h.requirement_id=r.id
    LEFT JOIN public.harness_sessions s ON s.id=h.session_id
    CROSS JOIN LATERAL (SELECT st.id,st.xmin AS status_xmin,st.updated_at FROM public.requirement_status st
      WHERE st.requirement_id=r.id ORDER BY st.updated_at DESC NULLS LAST,st.id DESC LIMIT 1) last_status
    WHERE r.status='blocked' AND h.pause_reason IN ('turn_budget_exhausted','active_time_budget_exhausted')
      AND r.xmin=h.xmin AND r.xmin=last_status.status_xmin
      AND (s.id IS NULL OR (s.snapshot->>'updatedAt')::timestamptz<=last_status.updated_at)
      AND NOT EXISTS (SELECT 1 FROM public.requirement_economic_pauses p WHERE p.requirement_id=r.id)
  LOOP PERFORM public.capture_requirement_economic_pause(entry.id); END LOOP;
END $$;

-- The ordinary drainer must not bypass recovery when a budget check paused
-- before a session existed (or its session was subsequently lost). Keep its
-- original ordered-prefix behavior for all other commands.
CREATE OR REPLACE FUNCTION public.apply_pending_requirement_commands()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; mapping public.harness_requirement_runs%ROWTYPE;
  session public.harness_sessions%ROWTYPE; owner public.remote_instances%ROWTYPE;
  command record; patch jsonb; action_status text; applied_ids uuid[]; assignments text; generation integer;
  t timestamptz:=clock_timestamp();
BEGIN
  FOR r IN SELECT q.* FROM public.requirements q
    WHERE EXISTS (SELECT 1 FROM public.requirement_commands c WHERE c.requirement_id=q.id AND c.applied_at IS NULL)
      AND (SELECT a.details->>'status' FROM public.requirement_commands c JOIN public.instance_logs a ON a.id=c.action_id
        WHERE c.requirement_id=q.id AND c.applied_at IS NULL ORDER BY c.revision LIMIT 1) IN ('completed','failed')
      AND (q.cron_lock_expires_at IS NULL OR q.cron_lock_expires_at<=t)
      AND q.status NOT IN ('cancelled','canceled')
      AND (q.metadata IS NULL OR jsonb_typeof(q.metadata)='object')
      AND NOT coalesce(q.metadata ? 'execution_hold',false)
      AND coalesce(q.metadata->>'user_paused','false')<>'true'
      AND coalesce(q.metadata->>'customer_paused','false')<>'true'
      AND coalesce(q.metadata->>'cron_paused','false')<>'true'
      AND NOT (q.status='blocked' AND EXISTS (SELECT 1 FROM public.harness_requirement_runs h
        WHERE h.requirement_id=q.id AND h.pause_reason IS NOT NULL
          AND (h.pause_reason IN ('token_budget_exhausted','account_credits_exhausted','turn_budget_exhausted','active_time_budget_exhausted')
            OR NOT EXISTS (SELECT 1 FROM public.harness_sessions resumed WHERE resumed.id=h.session_id
              AND resumed.site_id=q.site_id AND resumed.snapshot->>'status'='queued'))))
      AND NOT EXISTS (SELECT 1 FROM public.harness_requirement_runs h JOIN public.harness_sessions s ON s.id=h.session_id
        WHERE h.requirement_id=q.id AND (s.lease_expires_at>t OR s.snapshot->>'status' IN ('paused','cancelled')))
      AND NOT EXISTS (SELECT 1 FROM public.remote_instances i WHERE i.site_id=q.site_id
        AND i.id::text IN (q.metadata->>'runner_instance_id',q.metadata->>'assistant_origin_instance_id')
        AND i.status IN ('paused','stopped','stopping'))
      AND NOT EXISTS (SELECT 1 FROM public.instance_plans p WHERE p.site_id=q.site_id AND p.status='paused'
        AND (p.metadata->>'requirement_id'=q.id::text OR p.instance_id::text IN
          (q.metadata->>'runner_instance_id',q.metadata->>'assistant_origin_instance_id')))
    ORDER BY q.updated_at,q.id LIMIT 100 FOR UPDATE OF q SKIP LOCKED
  LOOP
    SELECT * INTO mapping FROM public.harness_requirement_runs WHERE requirement_id=r.id FOR UPDATE;
    IF FOUND THEN
      SELECT * INTO session FROM public.harness_sessions WHERE id=mapping.session_id FOR UPDATE;
      IF r.status='blocked' AND mapping.pause_reason IS NOT NULL AND (
        mapping.pause_reason IN ('token_budget_exhausted','account_credits_exhausted','turn_budget_exhausted','active_time_budget_exhausted')
        OR session.site_id IS DISTINCT FROM r.site_id OR session.snapshot->>'status' IS DISTINCT FROM 'queued') THEN CONTINUE; END IF;
      IF FOUND AND (session.lease_expires_at>clock_timestamp() OR session.snapshot->>'status' IN ('paused','cancelled')) THEN CONTINUE; END IF;
    END IF;
    owner:=NULL;
    FOR owner IN SELECT i.* FROM public.remote_instances i WHERE i.site_id=r.site_id
      AND i.id::text IN (r.metadata->>'runner_instance_id',r.metadata->>'assistant_origin_instance_id') ORDER BY i.id FOR UPDATE
    LOOP
      IF owner.status IN ('paused','stopped','stopping') THEN EXIT; END IF;
    END LOOP;
    IF owner.status IN ('paused','stopped','stopping') THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.instance_plans p WHERE p.site_id=r.site_id AND p.status='paused'
      AND (p.metadata->>'requirement_id'=r.id::text OR p.instance_id::text IN
        (r.metadata->>'runner_instance_id',r.metadata->>'assistant_origin_instance_id'))) THEN CONTINUE; END IF;
    generation:=0;
    IF r.metadata ? 'requirement_execution_generation' THEN
      IF coalesce(r.metadata->>'requirement_execution_generation','') !~ '^[0-9]{1,9}$' THEN CONTINUE; END IF;
      generation:=(r.metadata->>'requirement_execution_generation')::integer;
      IF generation>=999999999 THEN CONTINUE; END IF;
    END IF;
    patch:='{}'::jsonb; applied_ids:='{}'::uuid[];
    FOR command IN SELECT c.* FROM public.requirement_commands c
      WHERE c.requirement_id=r.id AND c.applied_at IS NULL ORDER BY c.revision FOR UPDATE
    LOOP
      SELECT a.details->>'status' INTO action_status FROM public.instance_logs a WHERE a.id=command.action_id FOR SHARE;
      IF NOT FOUND OR coalesce(action_status,'') NOT IN ('completed','failed') THEN EXIT; END IF;
      patch:=patch||command.patch; applied_ids:=array_append(applied_ids,command.action_id);
    END LOOP;
    IF cardinality(applied_ids)=0 THEN CONTINUE; END IF;
    SELECT string_agg(format('%I = (jsonb_populate_record(q, $1)).%I',key,key),', ' ORDER BY key)
      INTO assignments FROM jsonb_object_keys(patch-ARRAY['status','completion_status']) key;
    IF assignments IS NOT NULL THEN assignments:=assignments||', '; ELSE assignments:=''; END IF;
    EXECUTE 'UPDATE public.requirements q SET '||assignments||
      'status = ''in-progress'', completion_status = ''pending'', updated_at = $2, '||
      'metadata = coalesce(q.metadata, ''{}''::jsonb) || jsonb_build_object(''requirement_execution_generation'', $3), '||
      'cron_lock_run_id = NULL, cron_lock_expires_at = NULL, cron_lock_active = false WHERE q.id = $4'
      USING patch,clock_timestamp(),generation+1,r.id;
    UPDATE public.requirement_commands SET applied_at=clock_timestamp() WHERE requirement_id=r.id AND action_id=ANY(applied_ids);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.requirement_pause_command_guard(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.apply_recovered_requirement_commands(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;