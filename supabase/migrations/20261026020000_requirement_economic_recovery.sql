BEGIN;
SET LOCAL lock_timeout = '5s';

-- Private provenance, not a model-writable permission to restart work. A budget
-- edit is allowed; other requirement edits invalidate the captured row identity.
CREATE TABLE public.requirement_economic_pauses (
  requirement_id uuid PRIMARY KEY REFERENCES public.requirements(id) ON DELETE CASCADE,
  status_id uuid NOT NULL REFERENCES public.requirement_status(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  generation integer NOT NULL,
  requirement_guard jsonb NOT NULL,
  status_guard jsonb NOT NULL,
  session_version bigint,
  last_error_code text,
  checked_at timestamptz NOT NULL DEFAULT '-infinity'
);
ALTER TABLE public.requirement_economic_pauses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.requirement_economic_pauses FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX requirement_economic_pauses_check ON public.requirement_economic_pauses(checked_at,requirement_id);

-- Explicit controls must not retain an old economic reason. Otherwise pause
-- arriving just before cycle-finally could be mistaken for another budget stop.
CREATE OR REPLACE FUNCTION public.control_harness_session(p_id uuid,p_site_id uuid,p_action text,p_message text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.harness_sessions%ROWTYPE; s jsonb; result jsonb;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('pause','cancel','resume') OR length(p_message)>20000 THEN
    RAISE EXCEPTION 'Invalid harness control' USING ERRCODE='22023';
  END IF;
  SELECT * INTO r FROM public.harness_sessions WHERE id=p_id AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.snapshot->>'status' IN ('completed','cancelled')
    OR (p_action='resume' AND r.lease_expires_at>clock_timestamp()) THEN RETURN NULL; END IF;
  s:=r.snapshot||jsonb_build_object('status',CASE p_action WHEN 'resume' THEN 'queued' WHEN 'pause' THEN 'paused' ELSE 'cancelled' END);
  IF p_action IN ('pause','cancel') THEN
    s:=s||jsonb_build_object('reason',CASE p_action WHEN 'pause' THEN 'user_pause' ELSE 'user_cancel' END);
  END IF;
  IF p_action='resume' AND p_message IS NOT NULL AND length(p_message)>0 THEN
    s:=jsonb_set(s,'{messages}',(s->'messages')||jsonb_build_array(jsonb_build_object('role','user','content',p_message)));
  END IF;
  UPDATE public.harness_sessions SET version=version+1,lease_owner=NULL,lease_expires_at=NULL,
    snapshot=s||jsonb_build_object('version',version+1,'updatedAt',clock_timestamp())
    WHERE id=p_id AND site_id=p_site_id RETURNING snapshot INTO result;
  RETURN result;
END;
$$;

-- Same accounting as the cycle admission check. Observation only; no new charge
-- or reservation. Both paths share this function so refunds/attribution agree.
CREATE FUNCTION public.requirement_budget_observation(p_requirement_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; model_spent numeric; tool_spent numeric;
  sandbox_spent numeric; pending_models integer; total_spent numeric;
BEGIN
  SELECT * INTO STRICT r FROM public.requirements WHERE id=p_requirement_id;
  IF r.budget IS NOT NULL AND (r.budget<0 OR r.budget::text IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'Invalid requirement monetary budget';
  END IF;
  SELECT coalesce(sum(charged) FILTER (WHERE state='settled'),0),
    count(*) FILTER (WHERE state IN ('reserved','dispatched','pending'))
    INTO model_spent,pending_models FROM public.harness_model_credit_reservations
    WHERE requirement_id=r.id AND site_id=r.site_id;
  SELECT greatest(0,coalesce(-sum(charges.amount),0)) INTO tool_spent FROM (
    SELECT t.amount FROM public.credit_transactions t
    WHERE t.site_id=r.site_id AND t.metadata->>'requirement_id'=r.id::text
      AND t.transaction_type NOT IN ('sandbox_usage','agent_model_reservation',
        'agent_model_refund','agent_model_refund_expired','agent_model_settlement','agent_model_actual_cost')
    UNION ALL
    SELECT t.amount FROM public.harness_sessions s
    JOIN public.credit_transactions t ON t.site_id=s.site_id AND t.metadata->>'session_id'=s.id::text
    WHERE s.site_id=r.site_id AND s.snapshot#>>'{request,requirementId}'=r.id::text
      -- Never charge two requirements for conflicting provenance.
      AND t.metadata->>'requirement_id' IS NULL
      AND t.transaction_type NOT IN ('sandbox_usage','agent_model_reservation',
        'agent_model_refund','agent_model_refund_expired','agent_model_settlement','agent_model_actual_cost')
  ) charges;
  SELECT coalesce(sum(s.credits_charged),0) INTO sandbox_spent
    FROM public.sandbox_billing_sessions s
    JOIN public.sandbox_billing_resources b ON b.sandbox_name=s.sandbox_name
    WHERE b.site_id=r.site_id AND b.owner_kind='requirement' AND b.owner_id=r.id;
  total_spent:=model_spent+tool_spent+sandbox_spent;
  RETURN jsonb_build_object('state',CASE WHEN r.budget IS NULL THEN 'unlimited'
    WHEN total_spent>=r.budget THEN 'exhausted' ELSE 'available' END,
    'budget_usd',r.budget,'spent_usd',total_spent,'model_usd',model_spent,
    'tools_usd',tool_spent,'sandbox_usd',sandbox_spent,'pending_model_reservations',pending_models);
END;
$$;

CREATE OR REPLACE FUNCTION public.evaluate_requirement_cycle_budget(
  p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE observation jsonb;
BEGIN
  IF public.assert_agent_requirement_run(p_requirement_id,p_run_id,p_generation,p_session_id) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Requirement budget ownership changed' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.requirements WHERE id=p_requirement_id FOR UPDATE;
  -- No monetary cap: avoid all historical aggregation in ordinary admission.
  -- Recovery still uses the full observation to inspect pending reservations.
  IF (SELECT budget IS NULL FROM public.requirements WHERE id=p_requirement_id) THEN
    RETURN jsonb_build_object('state','unlimited','budget_usd',NULL);
  END IF;
  observation:=public.requirement_budget_observation(p_requirement_id);
  IF observation->>'state'='exhausted' THEN
    IF public.finish_agent_requirement_cycle(p_requirement_id,p_run_id,p_generation,p_session_id,
      'paused','token_budget_exhausted',format(
        'Requirement monetary budget exhausted: %s USD charged / %s USD budget. Checked at cycle start.',
        observation->>'spent_usd',observation->>'budget_usd')) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Requirement budget projection ownership changed' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN observation;
END;
$$;

-- Called only for a verified finish receipt (and conservative historical import).
CREATE FUNCTION public.capture_requirement_economic_pause(p_status_id uuid)
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
    OR h.pause_reason IS DISTINCT FROM 'token_budget_exhausted' OR h.next_run_at IS NOT NULL
    OR h.generation::text IS DISTINCT FROM r.metadata->>'requirement_execution_generation' THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.requirements q
    JOIN public.harness_requirement_runs m ON m.requirement_id=q.id
    JOIN public.requirement_status status ON status.id=st.id
    WHERE q.id=r.id AND q.xmin=m.xmin AND q.xmin=status.xmin) THEN RETURN; END IF;
  SELECT * INTO s FROM public.harness_sessions WHERE id=h.session_id;
  IF FOUND AND (s.site_id IS DISTINCT FROM r.site_id OR s.user_id IS DISTINCT FROM r.user_id
    OR s.snapshot->>'status' NOT IN ('queued','running','paused')
    OR (s.snapshot->>'status'='paused' AND s.snapshot->>'reason' IS DISTINCT FROM h.pause_reason)) THEN RETURN; END IF;
  INSERT INTO public.requirement_economic_pauses(requirement_id,status_id,session_id,generation,requirement_guard,status_guard,session_version)
    VALUES(r.id,st.id,h.session_id,h.generation,to_jsonb(r)-ARRAY['budget','updated_at'],to_jsonb(st),s.version)
    ON CONFLICT(requirement_id) DO UPDATE SET status_id=EXCLUDED.status_id,session_id=EXCLUDED.session_id,
      generation=EXCLUDED.generation,requirement_guard=EXCLUDED.requirement_guard,
      status_guard=EXCLUDED.status_guard,
      session_version=EXCLUDED.session_version,last_error_code=NULL,checked_at='-infinity';
END;
$$;

CREATE FUNCTION public.track_requirement_economic_pause()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='requirements' THEN
    -- Even SET status='blocked' on an already blocked row is a new manual stop.
    DELETE FROM public.requirement_economic_pauses WHERE requirement_id=NEW.id;
  ELSE
    PERFORM public.capture_requirement_economic_pause(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_economic_pause_invalidate AFTER UPDATE OF status ON public.requirements
  FOR EACH ROW EXECUTE FUNCTION public.track_requirement_economic_pause();
CREATE TRIGGER requirement_economic_pause_capture AFTER INSERT ON public.requirement_status
  FOR EACH ROW EXECUTE FUNCTION public.track_requirement_economic_pause();

-- Historical pauses need the same transaction's requirement, mapping and latest
-- status. Never infer permission from reason text alone or recover edited rows.
DO $$ DECLARE entry record; BEGIN
  FOR entry IN SELECT last_status.id FROM public.requirements r
    JOIN public.harness_requirement_runs h ON h.requirement_id=r.id
    LEFT JOIN public.harness_sessions s ON s.id=h.session_id
    CROSS JOIN LATERAL (SELECT st.id,st.xmin AS status_xmin,st.updated_at FROM public.requirement_status st
      WHERE st.requirement_id=r.id ORDER BY st.updated_at DESC NULLS LAST,st.id DESC LIMIT 1) last_status
    WHERE r.status='blocked' AND h.pause_reason='token_budget_exhausted'
      AND r.xmin=h.xmin AND r.xmin=last_status.status_xmin
      AND (s.id IS NULL OR (s.snapshot->>'updatedAt')::timestamptz<=last_status.updated_at)
  LOOP PERFORM public.capture_requirement_economic_pause(entry.id); END LOOP;
END $$;

CREATE FUNCTION public.recheck_requirement_economic_pauses(p_excluded_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE candidate record; receipt public.requirement_economic_pauses%ROWTYPE;
  r public.requirements%ROWTYPE; h public.harness_requirement_runs%ROWTYPE;
  s public.harness_sessions%ROWTYPE; latest public.requirement_status%ROWTYPE;
  observation jsonb; renewal jsonb; available numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('requirement-cron-global-capacity',0));
  -- Bounded rotating scan: unchanged depleted accounts cannot starve later rows.
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
    -- A subtransaction covers ALL recovery effects, including session control,
    -- lifecycle triggers and the audit insert. A late guard failure must roll
    -- back the resume without aborting admission for unrelated requirements.
    BEGIN
    IF to_jsonb(r)-ARRAY['budget','updated_at'] IS DISTINCT FROM receipt.requirement_guard
      OR r.status<>'blocked' OR r.cron_lock_expires_at>clock_timestamp()
      OR h.session_id IS DISTINCT FROM receipt.session_id OR h.generation IS DISTINCT FROM receipt.generation
      OR h.site_id IS DISTINCT FROM r.site_id OR h.pause_reason IS DISTINCT FROM 'token_budget_exhausted'
      OR h.next_run_at IS NOT NULL OR s.version IS DISTINCT FROM receipt.session_version
      OR s.lease_expires_at>clock_timestamp() THEN CONTINUE; END IF;
    SELECT * INTO latest FROM public.requirement_status WHERE requirement_id=r.id
      ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 1;
    IF latest.id IS DISTINCT FROM receipt.status_id OR to_jsonb(latest) IS DISTINCT FROM receipt.status_guard
      OR latest.cycle IS DISTINCT FROM 'agent:'||h.last_cycle_id THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.harness_sessions cleanup
      WHERE cleanup.sandbox_cleanup_token IS NOT NULL AND (
        cleanup.id=h.session_id
        OR (cleanup.site_id=r.site_id AND cleanup.snapshot#>>'{request,requirementId}'=r.id::text)
        OR cleanup.sandbox_cleanup_resource=s.snapshot#>>'{workspace,id}')) THEN CONTINUE; END IF;
    IF s.id IS NOT NULL AND (s.site_id IS DISTINCT FROM r.site_id OR s.user_id IS DISTINCT FROM r.user_id
      OR (s.snapshot#>>'{request,requirementId}' IS NOT NULL AND s.snapshot#>>'{request,requirementId}'<>r.id::text)
      OR s.snapshot->>'status' NOT IN ('queued','running','paused')
      OR (s.snapshot->>'status'='paused' AND s.snapshot->>'reason' IS DISTINCT FROM h.pause_reason)
      OR s.snapshot ? 'pending' OR s.snapshot->'uncertainOperations' IS DISTINCT FROM '[]'::jsonb
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'messages') msg,
        jsonb_array_elements(coalesce(msg->'toolCalls','[]'::jsonb)) call
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'messages') result
          WHERE result->>'role'='tool' AND result->>'toolCallId'=call->>'id'))) THEN CONTINUE; END IF;
    IF public.agent_requirement_runner_allowed(r.id,(r.metadata->>'runner_instance_id')::uuid) IS DISTINCT FROM true THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.harness_model_credit_reservations
      WHERE (requirement_id=r.id OR session_id=h.session_id)
        AND state IN ('reserved','dispatched','pending')) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.requirements other WHERE other.id<>r.id AND other.cron_lock_expires_at>clock_timestamp()
      AND (other.metadata->>'runner_instance_id'=r.metadata->>'runner_instance_id'
        OR other.metadata->>'assistant_origin_instance_id'=r.metadata->>'runner_instance_id')) THEN CONTINUE; END IF;
    -- Unknown accounting is not zero spend. One tenant's unavailable accounting
    -- cannot prevent ordinary cron work or another tenant's reevaluation.
      observation:=public.requirement_budget_observation(r.id);
      IF observation->>'state' NOT IN ('available','unlimited')
        OR (observation->>'pending_model_reservations')::integer<>0 THEN CONTINUE; END IF;
      renewal:=public.renew_site_plan_credits(r.site_id);
      IF renewal->>'success' IS DISTINCT FROM 'true' THEN CONTINUE; END IF;
      SELECT credits_available INTO available FROM public.billing WHERE site_id=r.site_id FOR UPDATE;
      IF NOT FOUND OR available IS NULL OR available<=0 OR available::text IN ('NaN','Infinity','-Infinity') THEN CONTINUE; END IF;
    -- Preflight, not a reservation: actual inference still reserves credits. The
    -- same generation/session continues; no fabricated user action or reset.
    IF s.id IS NOT NULL AND public.control_harness_session(s.id,r.site_id,'resume',NULL) IS NULL THEN CONTINUE; END IF;
    UPDATE public.requirements SET status='in-progress',updated_at=clock_timestamp() WHERE id=r.id;
    UPDATE public.harness_requirement_runs SET pause_reason=NULL,next_run_at=clock_timestamp() WHERE requirement_id=r.id;
    INSERT INTO public.requirement_status(requirement_id,site_id,instance_id,stage,cycle,message)
      VALUES(r.id,r.site_id,(r.metadata->>'runner_instance_id')::uuid,'in-progress','economic-recovery:'||h.last_cycle_id,
        format('Economic pause reevaluated: %s USD spent, %s USD budget, %s account credits available. Existing session retained.',
          observation->>'spent_usd',coalesce(observation->>'budget_usd','unlimited'),available));
    EXCEPTION WHEN OTHERS THEN
      -- Keep only SQLSTATE, never provider text or potentially sensitive values.
      UPDATE public.requirement_economic_pauses SET last_error_code=SQLSTATE WHERE requirement_id=r.id;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_agent_requirement_run(
  p_excluded_ids uuid[],p_max_concurrent integer,p_ttl_seconds integer,p_scheduled_ids uuid[] DEFAULT '{}'::uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_max_concurrent IS NULL OR p_max_concurrent NOT BETWEEN 1 AND 100
    OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 86400
    OR cardinality(p_excluded_ids)>10000 OR cardinality(p_scheduled_ids)>10000 THEN
    RAISE EXCEPTION 'Invalid agent cron claim' USING ERRCODE='22023';
  END IF;
  PERFORM public.recheck_requirement_economic_pauses(p_excluded_ids);
  PERFORM public.apply_pending_requirement_commands();
  RETURN public.claim_agent_requirement_run_before_commands(p_excluded_ids,p_max_concurrent,p_ttl_seconds,p_scheduled_ids);
END;
$$;
REVOKE ALL ON FUNCTION public.requirement_budget_observation(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.capture_requirement_economic_pause(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.track_requirement_economic_pause() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.recheck_requirement_economic_pauses(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;