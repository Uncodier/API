-- Review/offline only. Requires the agent cron and cross-instance-command migrations.
-- Preserve the public command-draining wrapper and all ownership/lease guards.
-- No data is updated at install time; historical wait recovery is claim-only.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Fail closed rather than silently installing an unused claim implementation.
DO $$ BEGIN
  IF to_regprocedure('public.claim_agent_requirement_run_before_commands(uuid[],integer,integer,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'Cross-instance requirement command migration is required';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.claim_agent_requirement_run_before_commands(
  p_excluded_ids uuid[], p_max_concurrent integer, p_ttl_seconds integer,
  p_scheduled_ids uuid[] DEFAULT '{}'::uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; m public.harness_requirement_runs%ROWTYPE;
  s public.harness_sessions%ROWTYPE; instance_id uuid; generation integer; run_id text;
  active integer; due boolean; has_mapping boolean; has_session boolean; recover_wait boolean; t timestamptz;
BEGIN
  IF p_max_concurrent IS NULL OR p_max_concurrent NOT BETWEEN 1 AND 100
    OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 86400
    OR cardinality(p_excluded_ids)>10000 OR cardinality(p_scheduled_ids)>10000
  THEN RAISE EXCEPTION 'Invalid agent cron claim' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('requirement-cron-global-capacity',0));
  t:=clock_timestamp();
  SELECT count(*) INTO active FROM public.requirements WHERE cron_lock_active IS TRUE AND cron_lock_expires_at>t;
  IF active>=p_max_concurrent THEN RETURN jsonb_build_object('state','capacity_full'); END IF;
  FOR r IN SELECT q.* FROM public.requirements q
    WHERE q.created_at>='2026-09-01 00:00:00+00'::timestamptz
      AND q.updated_at>='2026-09-01 00:00:00+00'::timestamptz
      AND q.site_id IS NOT NULL AND q.user_id IS NOT NULL
      AND (q.metadata IS NULL OR jsonb_typeof(q.metadata)='object')
      AND NOT (q.id=ANY(coalesce(p_excluded_ids,'{}'::uuid[])))
      AND (q.cron_lock_expires_at IS NULL OR q.cron_lock_expires_at<=t)
      AND NOT coalesce(q.metadata ? 'execution_hold',false)
      AND (q.status IN ('backlog','in-progress') OR
        (q.status='blocked' AND q.metadata->>'cron_blocker_provenance' IN
          ('product_no_progress_circuit','cron_infrastructure','product_attempt_budget','product_replan_circuit')) OR
        (q.status='blocked' AND EXISTS (SELECT 1 FROM public.harness_requirement_runs h WHERE h.requirement_id=q.id
          AND q.metadata->>'requirement_execution_generation' ~ '^[0-9]{1,9}$'
          AND (q.metadata->>'requirement_execution_generation')::integer>h.generation)) OR
        -- Only provably recoverable historical waits may consume the bounded
        -- candidate window. Repeat the evidence check under locks below: this
        -- prefilter is not authorization and cannot replace revalidation.
        (q.status='blocked' AND EXISTS (
          SELECT 1 FROM public.harness_requirement_runs h
          JOIN public.harness_sessions hs ON hs.id=h.session_id
          CROSS JOIN LATERAL (SELECT st.*,st.xmin AS status_xmin FROM public.requirement_status st
            WHERE st.requirement_id=q.id ORDER BY st.updated_at DESC NULLS LAST,st.id DESC LIMIT 1) last_status
          WHERE h.requirement_id=q.id AND h.site_id=q.site_id
            AND h.generation=CASE
              WHEN NOT coalesce(q.metadata ? 'requirement_execution_generation',false) THEN 0
              WHEN q.metadata->>'requirement_execution_generation' ~ '^[0-9]{1,9}$'
                THEN (q.metadata->>'requirement_execution_generation')::integer
              ELSE NULL END
            AND hs.site_id=q.site_id AND hs.user_id=q.user_id
            AND (hs.lease_expires_at IS NULL OR hs.lease_expires_at<=t)
            AND (hs.snapshot#>>'{request,requirementId}' IS NULL OR hs.snapshot#>>'{request,requirementId}'=q.id::text)
            AND hs.snapshot->>'status'='waiting' AND h.next_run_at IS NULL
            AND h.pause_reason=coalesce(hs.snapshot->>'reason','waiting')
            AND q.xmin=h.xmin AND q.xmin=last_status.status_xmin
            AND last_status.site_id=q.site_id
            AND last_status.instance_id::text=q.metadata->>'runner_instance_id'
            AND last_status.stage='blocked' AND last_status.cycle='agent:'||h.last_cycle_id
            -- Read-only admission checks here; the authoritative helper takes
            -- owner locks later, after the requirement/mapping/session locks.
            AND coalesce(q.metadata->>'customer_paused','false')<>'true'
            AND coalesce(q.metadata->>'user_paused','false')<>'true'
            AND coalesce(q.metadata->>'cron_paused','false')<>'true'
            AND EXISTS (SELECT 1 FROM public.remote_instances i WHERE i.id=last_status.instance_id
              AND i.site_id=q.site_id AND i.is_archived IS NOT TRUE
              AND i.status NOT IN ('paused','stopped','stopping','cancelled'))
            AND NOT EXISTS (SELECT 1 FROM public.instance_plans p WHERE p.site_id=q.site_id AND p.status='paused'
              AND (p.instance_id=last_status.instance_id OR p.metadata->>'requirement_id'=q.id::text))
            AND coalesce((SELECT coalesce(a.details->>'status','') IN ('completed','failed')
              FROM public.instance_logs a WHERE a.instance_id=last_status.instance_id AND a.site_id=q.site_id
                AND a.log_type='user_action' AND a.trusted_user_action IS TRUE
              ORDER BY a.created_at DESC,a.id DESC LIMIT 1),true)
            AND (q.metadata->>'assistant_origin_instance_id' IS NULL OR (
              EXISTS (SELECT 1 FROM public.remote_instances i WHERE i.id::text=q.metadata->>'assistant_origin_instance_id'
                AND i.site_id=q.site_id)
              AND coalesce((SELECT coalesce(a.details->>'status','') IN ('completed','failed')
                FROM public.instance_logs a WHERE a.instance_id::text=q.metadata->>'assistant_origin_instance_id'
                  AND a.site_id=q.site_id AND a.log_type='user_action' AND a.trusted_user_action IS TRUE
                ORDER BY a.created_at DESC,a.id DESC LIMIT 1),false)))
            AND NOT EXISTS (SELECT 1 FROM public.requirements other WHERE other.id<>q.id AND other.cron_lock_expires_at>t
              AND (other.metadata->>'runner_instance_id'=last_status.instance_id::text
                OR other.metadata->>'assistant_origin_instance_id'=last_status.instance_id::text)))) OR
        (q.status IN ('done','on-review') AND q.cron IS NOT NULL AND q.id=ANY(coalesce(p_scheduled_ids,'{}'::uuid[]))))
    ORDER BY q.updated_at,q.id LIMIT 1000 FOR UPDATE OF q SKIP LOCKED
  LOOP
    generation:=0;
    IF r.metadata ? 'requirement_execution_generation' THEN
      IF coalesce(r.metadata->>'requirement_execution_generation','') !~ '^[0-9]{1,9}$' THEN CONTINUE; END IF;
      generation:=(r.metadata->>'requirement_execution_generation')::integer;
    END IF;
    SELECT * INTO m FROM public.harness_requirement_runs WHERE requirement_id=r.id FOR UPDATE;
    has_mapping:=FOUND;
    IF has_mapping AND (m.site_id<>r.site_id OR generation<m.generation) THEN CONTINUE; END IF;
    due:=r.status IN ('done','on-review') AND r.cron IS NOT NULL AND r.id=ANY(coalesce(p_scheduled_ids,'{}'::uuid[]));
    SELECT * INTO s FROM public.harness_sessions WHERE id=m.session_id FOR UPDATE;
    has_session:=FOUND;
    IF has_session AND (s.site_id<>r.site_id OR s.user_id<>r.user_id OR s.lease_expires_at>clock_timestamp()
      OR (s.snapshot#>>'{request,requirementId}' IS NOT NULL AND s.snapshot#>>'{request,requirementId}'<>r.id::text)) THEN CONTINUE; END IF;
    recover_wait:=false;
    IF r.status='blocked' AND has_mapping AND has_session AND generation=m.generation
      AND s.snapshot->>'status'='waiting' AND m.next_run_at IS NULL
      AND m.pause_reason=coalesce(s.snapshot->>'reason','waiting') THEN
      -- Old finish wrote requirement, mapping and status in one transaction.
      -- Exact cycle + latest status + xmin equality reject later manual edits,
      -- including a manual block with an unchanged status string. If history was
      -- pruned/rewritten, fail closed; do not infer authorization from wait text.
      SELECT EXISTS (
        SELECT 1 FROM public.requirements q
        JOIN public.harness_requirement_runs h ON h.requirement_id=q.id
        CROSS JOIN LATERAL (SELECT st.* , st.xmin AS status_xmin FROM public.requirement_status st
          WHERE st.requirement_id=q.id ORDER BY st.updated_at DESC NULLS LAST,st.id DESC LIMIT 1) last_status
        WHERE q.id=r.id AND q.xmin=h.xmin AND q.xmin=last_status.status_xmin
          AND last_status.site_id=r.site_id
          AND last_status.instance_id::text=r.metadata->>'runner_instance_id'
          AND last_status.stage='blocked' AND last_status.cycle='agent:'||m.last_cycle_id
      ) INTO recover_wait;
    END IF;
    -- The wider candidate scan above grants no new manual-block escape hatch.
    IF r.status='blocked' AND NOT recover_wait
      AND NOT coalesce(r.metadata->>'cron_blocker_provenance' IN
        ('product_no_progress_circuit','cron_infrastructure','product_attempt_budget','product_replan_circuit'),false)
      AND NOT (has_mapping AND generation>m.generation) THEN CONTINUE; END IF;
    IF has_mapping AND NOT due AND generation=m.generation THEN
      IF m.next_run_at>clock_timestamp() OR (m.pause_reason IS NOT NULL AND m.next_run_at IS NULL AND NOT recover_wait) THEN CONTINUE; END IF;
      IF has_session AND s.snapshot->>'status' IN ('paused','cancelled')
      THEN CONTINUE; END IF;
    END IF;
    -- Existing identity is authoritative, even if missing/archived. Never replace.
    instance_id:=NULL;
    IF r.metadata->>'runner_instance_id' IS NOT NULL THEN
      SELECT id INTO instance_id FROM public.remote_instances WHERE id::text=r.metadata->>'runner_instance_id' AND site_id=r.site_id;
      IF instance_id IS NULL THEN CONTINUE; END IF;
    ELSIF r.metadata->>'assistant_origin_instance_id' IS NOT NULL THEN
      SELECT id INTO instance_id FROM public.remote_instances WHERE id::text=r.metadata->>'assistant_origin_instance_id' AND site_id=r.site_id;
      IF instance_id IS NULL THEN CONTINUE; END IF;
    ELSE
      SELECT p.instance_id INTO instance_id FROM public.instance_plans p WHERE p.site_id=r.site_id
        AND p.metadata->>'requirement_id'=r.id::text ORDER BY p.created_at,p.id LIMIT 1;
      IF NOT FOUND THEN
        SELECT id INTO instance_id FROM public.remote_instances WHERE site_id=r.site_id AND name='req-runner-'||r.id::text ORDER BY created_at,id LIMIT 1;
      END IF;
      IF instance_id IS NULL THEN
        -- User guards must precede even first-run infrastructure creation.
        IF coalesce(r.metadata->>'customer_paused','false')='true' OR coalesce(r.metadata->>'user_paused','false')='true'
          OR coalesce(r.metadata->>'cron_paused','false')='true' OR EXISTS (SELECT 1 FROM public.instance_plans
            WHERE site_id=r.site_id AND metadata->>'requirement_id'=r.id::text) THEN CONTINUE; END IF;
        INSERT INTO public.remote_instances(name,instance_type,status,is_archived,site_id,user_id,created_by)
          VALUES('req-runner-'||r.id::text,'browser','pending',false,r.site_id,r.user_id,r.user_id) RETURNING id INTO instance_id;
      END IF;
    END IF;
    IF NOT public.agent_requirement_runner_allowed(r.id,instance_id) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.requirements other WHERE other.id<>r.id AND other.cron_lock_expires_at>clock_timestamp()
      AND (other.metadata->>'runner_instance_id'=instance_id::text OR other.metadata->>'assistant_origin_instance_id'=instance_id::text)) THEN CONTINUE; END IF;
    IF has_session AND NOT due AND generation=m.generation AND s.snapshot->>'status'='completed' THEN
      -- Crash recovery: the durable terminal save may precede the cycle-finally
      -- call. Project its result after both leases expire; never replay its work.
      UPDATE public.requirements SET status='on-review',updated_at=clock_timestamp(),cron_lock_run_id=NULL,
        cron_lock_expires_at=NULL,cron_lock_active=false WHERE id=r.id;
      UPDATE public.harness_requirement_runs SET last_cycle_id=coalesce(r.cron_lock_run_id,'recovered:'||s.id::text),
        pause_reason=NULL,next_run_at=NULL WHERE requirement_id=r.id;
      INSERT INTO public.requirement_status(requirement_id,site_id,instance_id,stage,cycle,message)
        VALUES(r.id,r.site_id,instance_id,'on-review','agent-recovered:'||s.id::text,
          'Agent session completed; recovered its review handoff after an interrupted cycle.');
      CONTINUE;
    END IF;
    IF due THEN
      generation:=generation+1;
      -- Only an explicitly due terminal occurrence receives a new session/budget.
      IF has_session AND s.snapshot->>'status' NOT IN ('completed','cancelled') THEN CONTINUE; END IF;
      m.previous_session_id:=m.session_id;
      m.session_id:=gen_random_uuid();
    ELSIF has_session AND generation>m.generation THEN
      IF s.snapshot->>'status'='cancelled' THEN CONTINUE; END IF;
      -- Explicit user generation may resume; budgets/pending/workspace stay intact.
      IF s.snapshot->>'status'='completed' THEN
        UPDATE public.harness_sessions SET version=version+1,lease_owner=NULL,lease_expires_at=NULL,
          snapshot=snapshot||jsonb_build_object('status','queued','version',version+1,'updatedAt',clock_timestamp()) WHERE id=s.id;
      ELSE
        PERFORM public.control_harness_session(s.id,r.site_id,'resume',NULL);
      END IF;
    ELSIF has_session AND s.snapshot->>'status' IN ('waiting','failed') THEN
      PERFORM public.control_harness_session(s.id,r.site_id,'resume',NULL);
    END IF;
    IF NOT has_mapping THEN m.session_id:=gen_random_uuid(); END IF;
    run_id:='agent-cron-'||gen_random_uuid()::text;
    INSERT INTO public.harness_requirement_runs(requirement_id,site_id,session_id,previous_session_id,generation,next_run_at,pause_reason,last_cycle_id)
      VALUES(r.id,r.site_id,m.session_id,m.previous_session_id,generation,NULL,NULL,m.last_cycle_id)
      ON CONFLICT(requirement_id) DO UPDATE SET session_id=EXCLUDED.session_id,
        previous_session_id=CASE WHEN due THEN EXCLUDED.previous_session_id ELSE public.harness_requirement_runs.previous_session_id END,
        generation=EXCLUDED.generation,next_run_at=NULL,pause_reason=NULL;
    UPDATE public.requirements SET status='in-progress',updated_at=clock_timestamp(),cron_lock_run_id=run_id,cron_lock_active=true,
      cron_lock_expires_at=clock_timestamp()+make_interval(secs=>p_ttl_seconds),
      metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('runner_instance_id',instance_id,'requirement_execution_generation',generation)
      WHERE id=r.id RETURNING * INTO r;
    RETURN jsonb_build_object('state','claimed','requirement',to_jsonb(r),'run',jsonb_build_object(
      'requirementId',r.id,'siteId',r.site_id,'userId',r.user_id,'instanceId',instance_id,
      'runId',run_id,'executionGeneration',generation,'sessionId',m.session_id));
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_agent_requirement_cycle(p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid,
  p_session_status text,p_reason text,p_summary text,p_repo_url text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; s public.harness_sessions%ROWTYPE; target text; retry boolean; frozen boolean; t timestamptz:=clock_timestamp();
BEGIN
  IF p_session_status IS NULL OR p_session_status NOT IN ('queued','running','completed','waiting','paused','failed','cancelled')
    OR length(p_reason)>4000 OR length(p_summary)>20000 OR length(p_repo_url)>4000
  THEN RAISE EXCEPTION 'Invalid agent cycle result' USING ERRCODE='22023'; END IF;
  IF NOT public.assert_agent_requirement_run(p_requirement_id,p_run_id,p_generation,p_session_id,true,300) THEN
    -- Finally-release only our still-current lease; never undo a user pause.
    UPDATE public.requirements SET cron_lock_run_id=NULL,cron_lock_expires_at=NULL,cron_lock_active=false
      WHERE id=p_requirement_id AND cron_lock_run_id=p_run_id
        AND metadata->>'requirement_execution_generation'=p_generation::text
        AND EXISTS (SELECT 1 FROM public.harness_requirement_runs WHERE requirement_id=p_requirement_id AND session_id=p_session_id AND generation=p_generation);
    RETURN false;
  END IF;
  SELECT * INTO r FROM public.requirements WHERE id=p_requirement_id;
  SELECT * INTO s FROM public.harness_sessions WHERE id=p_session_id;
  -- An interactive control arriving after the worker snapshot must win over a
  -- stale worker's final projection. Never turn a newly paused session into done.
  IF FOUND AND s.snapshot->>'status' IN ('paused','cancelled') THEN
    p_session_status:=s.snapshot->>'status';
    p_reason:=coalesce(s.snapshot->>'reason',p_session_status);
  END IF;
  -- Waiting is agent continuation, not a product/user stop. The engine owns
  -- real budget, billing and authorization pauses; never weaken those statuses.
  retry:=p_session_status IN ('failed','waiting');
  frozen:=p_session_status IN ('paused','cancelled');
  target:=CASE WHEN p_session_status='completed' THEN 'on-review' WHEN frozen THEN 'blocked' ELSE 'in-progress' END;
  -- implemented is a review projection, never automatic product acceptance/done.
  UPDATE public.requirements SET status=target,updated_at=t,cron_lock_run_id=NULL,cron_lock_expires_at=NULL,cron_lock_active=false WHERE id=r.id;
  UPDATE public.harness_requirement_runs SET last_cycle_id=p_run_id,
    pause_reason=CASE WHEN frozen THEN coalesce(p_reason,p_session_status) ELSE NULL END,
    next_run_at=CASE WHEN retry THEN t+interval '60 seconds' WHEN p_session_status IN ('queued','running') THEN t ELSE NULL END
    WHERE requirement_id=r.id;
  INSERT INTO public.requirement_status(requirement_id,site_id,instance_id,stage,cycle,message,repo_url)
    VALUES(r.id,r.site_id,(r.metadata->>'runner_instance_id')::uuid,target,'agent:'||p_run_id,
      coalesce(nullif(p_summary,''),p_reason,p_session_status),p_repo_url);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_agent_requirement_run_before_commands(uuid[],integer,integer,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.finish_agent_requirement_cycle(uuid,text,integer,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.finish_agent_requirement_cycle(uuid,text,integer,uuid,text,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
