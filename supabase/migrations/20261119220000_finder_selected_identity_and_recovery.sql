-- Selected Finder identity, exact ACK recovery, and no-work dispatch settlement.
-- No historical leads, counters, reservations or list membership are rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.persons ADD COLUMN finder_selected_person_id text COLLATE "C",
  ADD CONSTRAINT persons_selected_identity CHECK (finder_selected_person_id IS NULL OR (
    external_person_id IS NULL AND finder_selected_person_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
    AND CASE WHEN finder_selected_person_id ~ '^(0|[1-9][0-9]{0,18})$'
      THEN finder_selected_person_id::numeric > 9223372036854775807 ELSE true END));
-- Canonical decimal IDs retain the existing BIGINT identity. A text ID is exact,
-- including leading zeroes. A missing role cannot create duplicate opaque rows.
CREATE UNIQUE INDEX persons_selected_identity_role ON public.persons(finder_selected_person_id,external_role_id)
  NULLS NOT DISTINCT WHERE finder_selected_person_id IS NOT NULL;

CREATE FUNCTION public.check_selected_icp_lead_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.processing_status = 'completed' AND NEW.lead_id IS NOT NULL THEN
    PERFORM 1 FROM public.leads l JOIN public.persons p ON p.id=l.person_id
      WHERE l.id=NEW.lead_id AND l.site_id=NEW.site_id
        AND coalesce(p.finder_selected_person_id,p.external_person_id::text)=NEW.person_id COLLATE "C"
      FOR SHARE OF l,p;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected lead identity mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.check_selected_icp_lead_identity() FROM PUBLIC,anon,authenticated,service_role;
-- Also protects existing workers using the old ACK signature. A mismatch rolls
-- back the member, selected counter and owned/budget checkpoint in one transaction.
CREATE TRIGGER verify_selected_icp_lead BEFORE INSERT OR UPDATE OF processing_status,lead_id,person_id,site_id
  ON public.icp_mining_people FOR EACH ROW EXECUTE FUNCTION public.check_selected_icp_lead_identity();

CREATE FUNCTION public.update_selected_finder_lead(p_site_id uuid,p_lead_id uuid,p_person_id uuid,
  p_selected_person_id text,p_segment_id uuid,p_finder_metadata jsonb,p_previous_finder_metadata jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_finder_metadata) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid Finder metadata'; END IF;
  -- A name/contact-key match is not authority to update a lead. Lock the lead
  -- and its actual person row, not merely the person originally prepared.
  PERFORM 1 FROM public.leads l JOIN public.persons p ON p.id=l.person_id
    WHERE l.id=p_lead_id AND l.site_id=p_site_id AND p.id=p_person_id
      AND coalesce(p.finder_selected_person_id,p.external_person_id::text)=p_selected_person_id COLLATE "C"
    FOR UPDATE OF l FOR SHARE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'Selected lead identity mismatch' USING ERRCODE='23514'; END IF;
  IF p_segment_id IS NOT NULL THEN
    PERFORM 1 FROM public.segments WHERE id=p_segment_id AND site_id=p_site_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid selected segment'; END IF;
  END IF;
  UPDATE public.leads l SET metadata=jsonb_set(coalesce(nullif(l.metadata,'null'::jsonb),'{}'::jsonb),'{finder}',p_finder_metadata),
    segment_id=coalesce(p_segment_id,l.segment_id)
    WHERE l.id=p_lead_id AND (l.metadata IS NULL OR jsonb_typeof(l.metadata) IN ('object','null'))
      AND nullif(l.metadata->'finder','null'::jsonb) IS NOT DISTINCT FROM nullif(p_previous_finder_metadata,'null'::jsonb);
  IF NOT FOUND THEN RAISE EXCEPTION 'Concurrent Finder metadata change' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('id',p_lead_id);
END $$;

CREATE FUNCTION public.insert_selected_finder_lead(p_site_id uuid,p_person_id uuid,p_selected_person_id text,p_lead jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE person public.persons; actor uuid; segment uuid; new_id uuid;
BEGIN
  IF p_site_id IS NULL OR p_selected_person_id IS NULL OR jsonb_typeof(p_lead) IS DISTINCT FROM 'object'
    OR (p_lead - ARRAY['name','email','phone','personal_email','user_id','company_id','segment_id','metadata','position','address','company','social_networks']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid selected lead request'; END IF;
  actor := (p_lead->>'user_id')::uuid; segment := (p_lead->>'segment_id')::uuid;
  IF public.selected_icp_creator_active(p_site_id,actor) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid selected lead creator'; END IF;
  IF coalesce(nullif(btrim(p_lead->>'email'),''),nullif(btrim(p_lead->>'personal_email'),''),nullif(btrim(p_lead->>'phone'),'')) IS NULL THEN
    RAISE EXCEPTION 'Selected lead needs a contact'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_site_id::text || ':' || p_selected_person_id,0));
  SELECT p.* INTO person FROM public.persons p WHERE p.id=p_person_id
    AND coalesce(p.finder_selected_person_id,p.external_person_id::text)=p_selected_person_id COLLATE "C" FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Selected person identity mismatch' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM public.persons p JOIN public.leads l ON l.person_id=p.id WHERE l.site_id=p_site_id
    AND (p.finder_selected_person_id=person.finder_selected_person_id OR p.external_person_id=person.external_person_id)) THEN
    RAISE EXCEPTION 'Selected person already has a lead' USING ERRCODE='23505'; END IF;
  IF segment IS NOT NULL THEN
    PERFORM 1 FROM public.segments WHERE id=segment AND site_id=p_site_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid selected segment'; END IF;
  END IF;
  INSERT INTO public.leads(site_id,person_id,user_id,name,email,phone,personal_email,company_id,segment_id,status,origin,
    metadata,position,address,company,social_networks)
    VALUES(p_site_id,p_person_id,actor,p_lead->>'name',coalesce(p_lead->>'email',''),p_lead->>'phone',p_lead->>'personal_email',
      (p_lead->>'company_id')::uuid,segment,'new','lead_enrichment_workflow',coalesce(p_lead->'metadata','{}'),p_lead->>'position',
      coalesce(p_lead->'address','{}'),coalesce(p_lead->'company','{}'),coalesce(p_lead->'social_networks','{}')) RETURNING id INTO new_id;
  RETURN jsonb_build_object('id',new_id);
END $$;

REVOKE ALL ON FUNCTION public.update_selected_finder_lead(uuid,uuid,uuid,text,uuid,jsonb,jsonb),
  public.insert_selected_finder_lead(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.update_selected_finder_lead(uuid,uuid,uuid,text,uuid,jsonb,jsonb),
  public.insert_selected_finder_lead(uuid,uuid,text,jsonb) TO service_role;

-- After an ambiguous ACK, replay *only the write*. Check its complete identity
-- and expected post-state under the checkpoint writer's lock before returning.
CREATE FUNCTION public.reconcile_selected_icp_person_ack(p_id uuid,p_site_id uuid,p_run_id uuid,
  p_ordinal bigint,p_person_id text,p_version integer,p_lead_id uuid,p_outcome text,p_processed integer,p_found integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.icp_mining; m public.icp_mining_people; receipt jsonb;
BEGIN
  IF p_version IS NULL OR p_version<1 OR p_processed IS NULL OR p_processed<1 OR p_found IS NULL
    OR p_found NOT BETWEEN 0 AND p_processed OR p_person_id IS NULL OR p_run_id IS NULL OR p_outcome IS NULL
    OR p_outcome NOT IN ('matched','no_match','needs_review') OR (p_outcome='matched') IS DISTINCT FROM (p_lead_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid selected ACK receipt'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(734210,1);
  SELECT * INTO r FROM public.icp_mining WHERE id=p_id AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND OR NOT r.execution_active OR r.execution_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'Selected ACK owner changed'; END IF;
  SELECT * INTO m FROM public.icp_mining_people WHERE ordinal=p_ordinal AND icp_mining_id=p_id
    AND site_id=p_site_id AND person_id=p_person_id COLLATE "C" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Selected ACK member changed'; END IF;
  IF m.processing_status='completed' THEN
    IF m.processed_run_id IS DISTINCT FROM p_run_id OR m.checkpoint_version IS DISTINCT FROM p_version
      OR m.outcome IS DISTINCT FROM p_outcome OR m.lead_id IS DISTINCT FROM p_lead_id
      OR (r.checkpoint_version,r.processed_targets,r.found_matches) IS DISTINCT FROM (p_version,p_processed,p_found) THEN
      RAISE EXCEPTION 'Conflicting selected ACK receipt'; END IF;
  ELSIF m.processing_status='pending' AND r.checkpoint_version=p_version-1
    AND coalesce(r.processed_targets,0)=p_processed-1 AND coalesce(r.found_matches,0)=p_found-(p_outcome='matched')::integer THEN
    receipt := public.acknowledge_selected_icp_person(p_id,p_site_id,p_run_id,p_ordinal,p_version,p_lead_id,p_outcome);
    IF receipt IS DISTINCT FROM jsonb_build_object('version',p_version,'processed',p_processed,'found',p_found) THEN
      RAISE EXCEPTION 'Selected ACK did not advance as expected'; END IF;
  ELSE RAISE EXCEPTION 'Conflicting selected ACK predecessor'; END IF;
  RETURN jsonb_build_object('version',p_version,'processed',p_processed,'found',p_found);
END $$;

ALTER TABLE public.icp_dispatch_runs ADD COLUMN preflight_retry_seconds integer
  CHECK (preflight_retry_seconds IS NULL OR
    (preflight_retry_seconds BETWEEN 0 AND 21600 AND state='settled' AND processed=0 AND found=0)),
  ADD COLUMN preflight_next_eligible_at timestamptz,
  ADD CONSTRAINT icp_preflight_receipt_complete CHECK ((preflight_retry_seconds IS NULL) = (preflight_next_eligible_at IS NULL));

-- Called before child work ONLY. A pristine owned claim is released and the
-- original zero-work reservation settled atomically, including its cooldown.
-- No timed release of active work and no refund/reclassification of old runs.
CREATE FUNCTION public.settle_icp_dispatch_preflight(p_id uuid,p_run_id uuid,p_workflow_id text,
  p_errors jsonb,p_retry_after_seconds integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.icp_dispatch_runs; r public.icp_mining; result jsonb;
BEGIN
  IF p_run_id IS NULL OR p_workflow_id IS NULL OR jsonb_typeof(p_errors) IS DISTINCT FROM 'array'
    OR p_retry_after_seconds IS NULL OR p_retry_after_seconds NOT BETWEEN 0 AND 21600 THEN RAISE EXCEPTION 'Invalid preflight settlement'; END IF;
  IF jsonb_array_length(p_errors) NOT BETWEEN 1 AND 20 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_errors) e WHERE jsonb_typeof(e)<>'string' OR length(e#>>'{}')>1000
  ) THEN RAISE EXCEPTION 'Invalid preflight diagnostics'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(734210,1);
  SELECT * INTO d FROM public.icp_dispatch_runs WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR d.run_id IS DISTINCT FROM p_run_id OR d.workflow_id IS DISTINCT FROM p_workflow_id THEN
    RAISE EXCEPTION 'Preflight dispatch ownership lost'; END IF;
  IF d.state='settled' THEN
    IF d.preflight_retry_seconds IS DISTINCT FROM p_retry_after_seconds OR d.error IS DISTINCT FROM p_errors::text THEN
      RAISE EXCEPTION 'Conflicting preflight settlement'; END IF;
    RETURN jsonb_build_object('success',true,'next_eligible_at',d.preflight_next_eligible_at);
  END IF;
  SELECT * INTO r FROM public.icp_mining WHERE id=d.icp_mining_id AND site_id=d.site_id FOR UPDATE;
  IF NOT FOUND OR d.state<>'running' OR NOT r.execution_active OR r.status<>'running'
    OR r.execution_run_id IS DISTINCT FROM p_run_id OR r.execution_workflow_id IS DISTINCT FROM p_workflow_id
    OR r.checkpoint_version<>0 OR coalesce(r.processed_targets,0) IS DISTINCT FROM d.baseline_processed
    OR coalesce(r.found_matches,0) IS DISTINCT FROM d.baseline_found THEN RAISE EXCEPTION 'Preflight claim is not pristine'; END IF;
  PERFORM pg_catalog.set_config('app.icp_execution_owner',p_run_id::text,true);
  UPDATE public.icp_mining SET status='pending',execution_active=false,checkpoint_version=1,last_error=p_errors::text,
    last_progress_at=now() WHERE id=r.id;
  result := public.finish_icp_dispatch(p_id,p_run_id,p_errors,p_retry_after_seconds);
  UPDATE public.icp_dispatch_runs SET preflight_retry_seconds=p_retry_after_seconds,
    preflight_next_eligible_at=(result->>'next_eligible_at')::timestamptz WHERE id=p_id;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.reconcile_selected_icp_person_ack(uuid,uuid,uuid,bigint,text,integer,uuid,text,integer,integer),
  public.settle_icp_dispatch_preflight(uuid,uuid,text,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_selected_icp_person_ack(uuid,uuid,uuid,bigint,text,integer,uuid,text,integer,integer),
  public.settle_icp_dispatch_preflight(uuid,uuid,text,jsonb,integer) TO service_role;
COMMIT;