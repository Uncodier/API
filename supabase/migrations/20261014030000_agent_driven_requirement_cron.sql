-- Review/offline only. Deployments MUST drain legacy workers before switching
-- cron dispatch. Live legacy leases are never revoked by this migration/RPC.
-- Requires 20261014010000 and 20261014020000; no product completion gates.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Fail early if host persistence has not been installed; no deployment fallback.
DO $$ BEGIN
  IF to_regclass('public.harness_sessions') IS NULL OR to_regclass('public.harness_host_state') IS NULL THEN
    RAISE EXCEPTION 'Portable harness session and host-state migrations are required';
  END IF;
END $$;

CREATE TABLE public.harness_requirement_runs (
  requirement_id uuid PRIMARY KEY REFERENCES public.requirements(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id),
  -- Reserved before the host creates a session: intentionally no session FK.
  session_id uuid NOT NULL UNIQUE,
  -- Host-only provenance for safe workspace adoption across scheduled occurrences.
  -- No FK: the prior session may have been pruned independently.
  previous_session_id uuid,
  generation integer NOT NULL CHECK (generation >= 0),
  next_run_at timestamptz,
  pause_reason text,
  last_cycle_id text,
  workspace_id text
);
ALTER TABLE public.harness_requirement_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.harness_requirement_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.harness_requirement_runs TO service_role;

-- Only user/ownership guards. Never inspect attempts, acceptance, backlog status,
-- deployment validations, circuit counters, or product-specific tools.
CREATE FUNCTION public.agent_requirement_runner_allowed(p_requirement_id uuid, p_instance_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; i public.remote_instances%ROWTYPE; a public.instance_logs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.requirements WHERE id=p_requirement_id;
  IF NOT FOUND OR r.metadata ? 'execution_hold'
    OR coalesce(r.metadata->>'customer_paused','false')='true'
    OR coalesce(r.metadata->>'user_paused','false')='true'
    OR coalesce(r.metadata->>'cron_paused','false')='true' THEN RETURN false; END IF;
  -- Existing assistant admission takes SHARE on this instance. UPDATE also
  -- fences legacy-discovered owners before runner_instance_id has been bound.
  SELECT * INTO i FROM public.remote_instances WHERE id=p_instance_id AND site_id=r.site_id FOR UPDATE;
  IF NOT FOUND OR i.is_archived IS TRUE OR i.status IN ('paused','stopped','stopping','cancelled') THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.instance_plans WHERE site_id=r.site_id AND status='paused'
    AND (instance_id=i.id OR metadata->>'requirement_id'=r.id::text)) THEN RETURN false; END IF;
  SELECT * INTO a FROM public.instance_logs WHERE instance_id=i.id AND site_id=r.site_id
    AND log_type='user_action' AND trusted_user_action IS TRUE ORDER BY created_at DESC,id DESC LIMIT 1;
  IF FOUND AND coalesce(a.details->>'status','') NOT IN ('completed','failed') THEN RETURN false; END IF;
  IF r.metadata->>'assistant_origin_instance_id' IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.remote_instances WHERE id::text=r.metadata->>'assistant_origin_instance_id'
      AND site_id=r.site_id) THEN RETURN false; END IF;
    SELECT * INTO a FROM public.instance_logs WHERE instance_id::text=r.metadata->>'assistant_origin_instance_id'
      AND site_id=r.site_id AND log_type='user_action' AND trusted_user_action IS TRUE
      ORDER BY created_at DESC,id DESC LIMIT 1;
    IF NOT FOUND OR coalesce(a.details->>'status','') NOT IN ('completed','failed') THEN RETURN false; END IF;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION public.claim_agent_requirement_run(
  p_excluded_ids uuid[], p_max_concurrent integer, p_ttl_seconds integer,
  p_scheduled_ids uuid[] DEFAULT '{}'::uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; m public.harness_requirement_runs%ROWTYPE;
  s public.harness_sessions%ROWTYPE; instance_id uuid; generation integer; run_id text;
  active integer; due boolean; has_mapping boolean; has_session boolean; t timestamptz;
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
    IF has_mapping AND NOT due AND generation=m.generation THEN
      IF m.next_run_at>clock_timestamp() OR (m.pause_reason IS NOT NULL AND m.next_run_at IS NULL) THEN CONTINUE; END IF;
      IF has_session AND (s.snapshot->>'status' IN ('paused','cancelled')
        OR (s.snapshot->>'status'='waiting' AND NOT (coalesce(s.snapshot->>'reason','') ~ '^(runtime_unavailable|dispatch_unavailable|model_unavailable|model_response_too_large)(:|$)')))
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

CREATE FUNCTION public.assert_agent_requirement_run(p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid,
  p_allow_terminal boolean DEFAULT false,p_renew_seconds integer DEFAULT 300)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; m public.harness_requirement_runs%ROWTYPE; s public.harness_sessions%ROWTYPE; i uuid;
BEGIN
  IF p_run_id IS NULL OR p_generation IS NULL OR p_session_id IS NULL OR p_allow_terminal IS NULL
    OR p_renew_seconds IS NULL OR p_renew_seconds NOT BETWEEN 1 AND 300 THEN RETURN false; END IF;
  SELECT * INTO r FROM public.requirements WHERE id=p_requirement_id FOR UPDATE;
  IF NOT FOUND OR r.cron_lock_run_id IS DISTINCT FROM p_run_id OR r.cron_lock_active IS NOT TRUE
    OR r.cron_lock_expires_at IS NULL OR r.cron_lock_expires_at<=clock_timestamp()
    OR r.metadata->>'requirement_execution_generation' IS DISTINCT FROM p_generation::text
    OR r.status IS NULL OR (r.status NOT IN ('backlog','in-progress') AND NOT (p_allow_terminal AND r.status IN ('blocked','on-review','done')))
  THEN RETURN false; END IF;
  SELECT * INTO m FROM public.harness_requirement_runs WHERE requirement_id=r.id FOR UPDATE;
  IF NOT FOUND OR m.site_id<>r.site_id OR m.session_id<>p_session_id OR m.generation<>p_generation THEN RETURN false; END IF;
  SELECT id INTO i FROM public.remote_instances WHERE id::text=r.metadata->>'runner_instance_id' AND site_id=r.site_id;
  IF i IS NULL OR NOT public.agent_requirement_runner_allowed(r.id,i) THEN RETURN false; END IF;
  SELECT * INTO s FROM public.harness_sessions WHERE id=p_session_id FOR UPDATE;
  IF FOUND THEN
    IF s.site_id<>r.site_id OR s.user_id<>r.user_id
      OR (s.snapshot#>>'{request,requirementId}' IS NOT NULL AND s.snapshot#>>'{request,requirementId}'<>r.id::text)
      OR (NOT p_allow_terminal AND s.snapshot->>'status' NOT IN ('queued','running')) THEN RETURN false; END IF;
    -- Session token is separate: never replace owner, reset counters, or revive an
    -- expired session lease. The engine independently asserts its exact token.
    IF s.lease_expires_at>clock_timestamp() AND s.snapshot->>'status'='running' THEN
      UPDATE public.harness_sessions SET lease_expires_at=clock_timestamp()+make_interval(secs=>p_renew_seconds) WHERE id=s.id;
    END IF;
  END IF;
  UPDATE public.requirements SET cron_lock_expires_at=clock_timestamp()+make_interval(secs=>p_renew_seconds) WHERE id=r.id;
  RETURN true;
END;
$$;

CREATE FUNCTION public.finish_agent_requirement_cycle(p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid,
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
  retry:=p_session_status='failed' OR (p_session_status='waiting' AND coalesce(p_reason,'') ~ '^(runtime_unavailable|dispatch_unavailable|model_unavailable|model_response_too_large)(:|$)');
  frozen:=p_session_status IN ('paused','cancelled') OR (p_session_status='waiting' AND NOT retry);
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

CREATE FUNCTION public.patch_agent_requirement_progress(p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid,
  p_plan_id uuid,p_step_id text,p_item_id text,p_status text,p_message text,p_expected_backlog_revision bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; p public.instance_plans%ROWTYPE; entries jsonb; n integer; revision bigint;
  step_status text; item_status text;
BEGIN
  step_status:=CASE WHEN p_status='done' THEN 'completed' ELSE p_status END;
  item_status:=CASE WHEN p_status='completed' THEN 'done' ELSE p_status END;
  IF length(p_message)>20000 OR length(p_step_id)>200 OR length(p_item_id)>200
    OR (p_step_id IS NOT NULL AND p_plan_id IS NULL)
    OR (p_status IS NOT NULL AND p_status NOT IN ('pending','in_progress','completed','done','failed'))
    OR (p_status IS NOT NULL AND p_plan_id IS NULL AND p_item_id IS NULL)
    OR (p_status IS NULL AND nullif(p_message,'') IS NULL)
  THEN RAISE EXCEPTION 'Invalid agent progress patch' USING ERRCODE='22023'; END IF;
  IF NOT public.assert_agent_requirement_run(p_requirement_id,p_run_id,p_generation,p_session_id) THEN
    RETURN jsonb_build_object('state','stale'); END IF;
  SELECT * INTO r FROM public.requirements WHERE id=p_requirement_id;
  revision:=coalesce(r.backlog_revision,0);
  IF p_expected_backlog_revision IS NOT NULL AND p_expected_backlog_revision<>revision THEN
    RETURN jsonb_build_object('state','revision_conflict','backlog_revision',revision); END IF;
  IF p_plan_id IS NOT NULL THEN
    SELECT * INTO p FROM public.instance_plans WHERE id=p_plan_id AND site_id=r.site_id
      AND instance_id::text=r.metadata->>'runner_instance_id' FOR UPDATE;
    IF NOT FOUND OR p.status='paused' OR (p.metadata->>'requirement_id' IS NOT NULL AND p.metadata->>'requirement_id'<>r.id::text) THEN
      RETURN jsonb_build_object('state','stale'); END IF;
  END IF;
  -- Validate both targets before updating either, so a missing item cannot
  -- partially commit a step. Existing metadata/acceptance/attempts stay untouched.
  IF p_step_id IS NOT NULL AND p_status IS NOT NULL THEN
    IF jsonb_typeof(p.steps) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('state','not_found'); END IF;
    SELECT count(*) INTO n FROM jsonb_array_elements(p.steps) e WHERE e->>'id'=p_step_id;
    IF n<>1 THEN RETURN jsonb_build_object('state','not_found'); END IF;
  END IF;
  IF p_item_id IS NOT NULL AND p_status IS NOT NULL THEN
    IF jsonb_typeof(r.backlog->'items') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('state','not_found'); END IF;
    SELECT count(*) INTO n FROM jsonb_array_elements(r.backlog->'items') e WHERE e->>'id'=p_item_id;
    IF n<>1 THEN RETURN jsonb_build_object('state','not_found'); END IF;
  END IF;
  IF p_plan_id IS NOT NULL AND p_step_id IS NULL AND p_status IS NOT NULL THEN
    UPDATE public.instance_plans SET status=step_status,updated_at=clock_timestamp() WHERE id=p.id;
  END IF;
  IF p_step_id IS NOT NULL AND p_status IS NOT NULL THEN
    SELECT jsonb_agg(CASE WHEN e->>'id'=p_step_id THEN e||jsonb_build_object('status',step_status) ELSE e END ORDER BY ord)
      INTO entries FROM jsonb_array_elements(p.steps) WITH ORDINALITY a(e,ord);
    UPDATE public.instance_plans SET steps=entries,updated_at=clock_timestamp() WHERE id=p.id;
  END IF;
  IF p_item_id IS NOT NULL AND p_status IS NOT NULL THEN
    SELECT jsonb_agg(CASE WHEN e->>'id'=p_item_id THEN e||jsonb_build_object('status',item_status) ELSE e END ORDER BY ord)
      INTO entries FROM jsonb_array_elements(r.backlog->'items') WITH ORDINALITY a(e,ord);
    UPDATE public.requirements SET backlog=jsonb_set(backlog,'{items}',entries),backlog_revision=revision+1
      WHERE id=r.id RETURNING backlog_revision INTO revision;
  END IF;
  IF nullif(p_message,'') IS NOT NULL THEN
    INSERT INTO public.requirement_status(requirement_id,site_id,instance_id,stage,message)
      VALUES(r.id,r.site_id,(r.metadata->>'runner_instance_id')::uuid,'in-progress',p_message);
  END IF;
  RETURN jsonb_build_object('state','updated','backlog_revision',revision);
END;
$$;

-- Existing AFTER status trigger otherwise reintroduces legacy product validation
-- even though the new RPC never calls that workflow. Keep operator/platform
-- holds and immutable handoff checks, and keep automatic `done` forbidden. A
-- durable completed agent session permits review, not migration acceptance.
CREATE OR REPLACE FUNCTION public.guard_requirement_migration_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status='blocked' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.requirement_migration_lifecycle l WHERE l.requirement_id=NEW.id
    AND (l.state='platform_review' OR (l.state='transferred' AND NOT public.migration_execution_handoff_matches(l)))) THEN
    RAISE EXCEPTION 'Requirement is blocked by migration platform review or invalid handoff' USING ERRCODE='23514';
  END IF;
  IF NEW.status='on-review' AND EXISTS (
    SELECT 1 FROM public.harness_requirement_runs h JOIN public.harness_sessions s ON s.id=h.session_id
    WHERE h.requirement_id=NEW.id AND h.site_id=NEW.site_id AND s.site_id=NEW.site_id AND s.user_id=NEW.user_id
      AND h.generation::text=NEW.metadata->>'requirement_execution_generation'
      AND s.snapshot->>'status'='completed'
      AND (s.snapshot#>>'{request,requirementId}' IS NULL OR s.snapshot#>>'{request,requirementId}'=NEW.id::text)
  ) THEN RETURN NEW; END IF;
  IF NEW.status IN ('done','on-review') AND EXISTS (SELECT 1 FROM public.requirement_migration_lifecycle l
    WHERE l.requirement_id=NEW.id AND l.state<>'validated' AND NOT public.migration_execution_handoff_matches(l)) THEN
    RAISE EXCEPTION 'Requirement has unvalidated migration lifecycle records' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_requirement_migration_status() FROM PUBLIC,anon,authenticated,service_role;

-- Quarantine remains evidence, not a prohibition on technical work. Only the
-- current agent may change its status while retaining every other item byte.
-- Legacy callers still need the exact trusted-user release protocol below.
CREATE OR REPLACE FUNCTION public.enforce_requirement_review_quarantine()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE old_item jsonb; new_item jsonb; action_created_at timestamptz; agent_owned boolean;
BEGIN
  IF NEW.backlog IS NOT DISTINCT FROM OLD.backlog THEN RETURN NEW; END IF;
  agent_owned:=false;
  IF NEW.cron_lock_active IS TRUE AND NEW.cron_lock_run_id=OLD.cron_lock_run_id
    AND NEW.cron_lock_expires_at>clock_timestamp() AND NEW.status='in-progress'
    AND NEW.metadata IS NOT DISTINCT FROM OLD.metadata
    AND EXISTS (SELECT 1 FROM public.harness_requirement_runs h JOIN public.harness_sessions s ON s.id=h.session_id
      WHERE h.requirement_id=NEW.id AND h.site_id=NEW.site_id AND s.site_id=NEW.site_id AND s.user_id=NEW.user_id
        AND h.generation::text=NEW.metadata->>'requirement_execution_generation'
        AND s.snapshot->>'status' IN ('queued','running')) THEN
    agent_owned:=public.agent_requirement_runner_allowed(NEW.id,(NEW.metadata->>'runner_instance_id')::uuid);
  END IF;
  FOR old_item IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD.backlog->'items')='array'
    THEN OLD.backlog->'items' ELSE '[]'::jsonb END)
    WHERE value->>'status'='needs_review' OR coalesce(value#>>'{review_quarantine,active}','false')='true'
  LOOP
    SELECT value INTO new_item FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.backlog->'items')='array'
      THEN NEW.backlog->'items' ELSE '[]'::jsonb END) WHERE value->>'id'=old_item->>'id' LIMIT 1;
    IF agent_owned AND new_item-'status'=old_item-'status'
      AND new_item->>'status' IN ('pending','in_progress','done','failed') THEN CONTINUE; END IF;
    IF new_item IS NULL OR new_item->>'status'<>'needs_review' OR coalesce(new_item#>>'{review_quarantine,active}','false')<>'true' THEN
      IF NEW.external_user_action_revision<>OLD.external_user_action_revision+1 OR nullif(NEW.last_external_user_action_id,'') IS NULL
        OR new_item IS NULL OR new_item#>>'{review_quarantine,released_by_action_id}' IS DISTINCT FROM NEW.last_external_user_action_id THEN
        RAISE EXCEPTION 'Backlog item % is quarantined; a trusted newer user action must release it',old_item->>'id';
      END IF;
      SELECT log.created_at INTO action_created_at FROM public.instance_logs log
        WHERE log.id::text=NEW.last_external_user_action_id AND log.log_type='user_action' AND log.trusted_user_action=true
          AND log.details->>'requirement_id'=NEW.id::text LIMIT 1;
      IF action_created_at IS NULL OR action_created_at<=public.requirement_quarantine_timestamp(old_item) THEN
        RAISE EXCEPTION 'Backlog item % quarantine predates no trusted user action',old_item->>'id';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_requirement_review_quarantine() FROM PUBLIC,anon,authenticated,service_role;

-- The generic API still cannot reopen a terminal session. Only a host-authored
-- newer requirement generation may reopen completed work, with an identical
-- transcript, limits, counters and workspace. Cancelled is never auto-resumed.
CREATE OR REPLACE FUNCTION public.guard_harness_session()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE explicit_reopen boolean:=false;
BEGIN
  IF NOT public.valid_harness_snapshot(NEW.snapshot) THEN RAISE EXCEPTION 'Invalid harness snapshot' USING ERRCODE='22023'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.snapshot->>'status'<>'queued' OR NEW.version<>0
      OR (NEW.snapshot->>'turns')::numeric<>0 OR (NEW.snapshot->>'allocatedTokens')::numeric<>0 OR (NEW.snapshot->>'activeMs')::numeric<>0
      OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial harness session' USING ERRCODE='22023'; END IF;
  ELSE
    explicit_reopen:=OLD.snapshot->>'status'='completed' AND NEW.snapshot->>'status'='queued'
      AND (OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp())
      AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
      AND NEW.snapshot-ARRAY['status','version','updatedAt']=OLD.snapshot-ARRAY['status','version','updatedAt']
      AND EXISTS (SELECT 1 FROM public.harness_requirement_runs h JOIN public.requirements r ON r.id=h.requirement_id
        WHERE h.session_id=OLD.id AND h.site_id=OLD.site_id AND r.site_id=OLD.site_id AND r.user_id=OLD.user_id
          AND r.status IN ('backlog','in-progress','blocked') AND NOT coalesce(r.metadata ? 'execution_hold',false)
          AND CASE WHEN r.metadata->>'requirement_execution_generation' ~ '^[0-9]{1,9}$'
            THEN (r.metadata->>'requirement_execution_generation')::integer>h.generation ELSE false END);
    IF NEW.id<>OLD.id OR NEW.site_id<>OLD.site_id OR NEW.user_id<>OLD.user_id
      OR NEW.snapshot->'request' IS DISTINCT FROM OLD.snapshot->'request'
      OR NEW.snapshot->'createdAt' IS DISTINCT FROM OLD.snapshot->'createdAt'
      OR (OLD.snapshot ? 'workspace' AND NEW.snapshot->'workspace' IS DISTINCT FROM OLD.snapshot->'workspace') THEN
      RAISE EXCEPTION 'Harness identity is immutable' USING ERRCODE='22023'; END IF;
    IF NEW.version<OLD.version OR NEW.version>OLD.version+1
      OR (NEW.snapshot IS DISTINCT FROM OLD.snapshot AND NEW.version<>OLD.version+1)
      OR (OLD.snapshot->>'status' IN ('completed','cancelled') AND NEW.snapshot IS DISTINCT FROM OLD.snapshot AND NOT explicit_reopen)
      OR (NEW.snapshot->>'turns')::numeric<(OLD.snapshot->>'turns')::numeric
      OR (NEW.snapshot->>'allocatedTokens')::numeric<(OLD.snapshot->>'allocatedTokens')::numeric
      OR (NEW.snapshot->>'activeMs')::numeric<(OLD.snapshot->>'activeMs')::numeric
      OR NOT ((NEW.snapshot->'uncertainOperations') @> (OLD.snapshot->'uncertainOperations')) THEN
      RAISE EXCEPTION 'Invalid harness snapshot update' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_harness_session() FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION public.agent_requirement_runner_allowed(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.claim_agent_requirement_run(uuid[],integer,integer,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assert_agent_requirement_run(uuid,text,integer,uuid,boolean,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.finish_agent_requirement_cycle(uuid,text,integer,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_agent_requirement_run(uuid[],integer,integer,uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_agent_requirement_run(uuid,text,integer,uuid,boolean,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_agent_requirement_cycle(uuid,text,integer,uuid,text,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.patch_agent_requirement_progress(uuid,text,integer,uuid,uuid,text,text,text,text,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.patch_agent_requirement_progress(uuid,text,integer,uuid,uuid,text,text,text,text,bigint) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;