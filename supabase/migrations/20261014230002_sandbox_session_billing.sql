BEGIN;
SET LOCAL lock_timeout = '5s';

-- Intentionally empty at rollout. A host registers before new VM dispatch or
-- before adopting an existing VM: nothing prior to that instant is billable.
CREATE TABLE public.sandbox_billing_resources (
  sandbox_name text PRIMARY KEY CHECK (length(sandbox_name) BETWEEN 1 AND 200),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_reconciled_at timestamptz,
  deletion_requested_at timestamptz,
  retired_at timestamptz,
  owner_kind text NOT NULL CHECK (owner_kind IN ('harness','requirement','workflow')),
  owner_id uuid NOT NULL
);
CREATE TABLE public.sandbox_billing_sessions (
  session_id text PRIMARY KEY CHECK (length(session_id) BETWEEN 1 AND 200),
  sandbox_name text NOT NULL REFERENCES public.sandbox_billing_resources(sandbox_name),
  started_at timestamptz NOT NULL,
  billed_through timestamptz NOT NULL,
  ended_at timestamptz,
  credits_charged numeric NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
  CHECK (billed_through >= started_at)
);
ALTER TABLE public.sandbox_billing_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sandbox_billing_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sandbox_billing_resources, public.sandbox_billing_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sandbox_billing_resources, public.sandbox_billing_sessions TO service_role;
CREATE POLICY sandbox_resources_service ON public.sandbox_billing_resources FOR SELECT TO service_role USING (true);
CREATE POLICY sandbox_sessions_service ON public.sandbox_billing_sessions FOR SELECT TO service_role USING (true);

CREATE FUNCTION public.register_sandbox_billing(p_sandbox_name text, p_owner_kind text,
  p_owner_id uuid, p_site_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_site uuid; v_requirement uuid; v_available numeric; r public.sandbox_billing_resources%ROWTYPE;
BEGIN
  IF p_sandbox_name IS NULL OR length(p_sandbox_name) NOT BETWEEN 1 AND 200 OR p_owner_id IS NULL THEN
    RAISE EXCEPTION 'Invalid sandbox billing owner';
  END IF;
  -- Never trust provider tags, model-selected site IDs, or audit log metadata.
  IF p_owner_kind = 'harness' THEN
    SELECT site_id, (snapshot#>>'{request,requirementId}')::uuid INTO v_site,v_requirement
      FROM public.harness_sessions WHERE id = p_owner_id FOR SHARE;
    -- Repeated occurrences of one requirement share the same durable owner.
    IF v_requirement IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.requirements WHERE id=v_requirement AND site_id=v_site) THEN
        RAISE EXCEPTION 'Sandbox billing requirement ownership mismatch';
      END IF;
      p_owner_kind := 'requirement'; p_owner_id := v_requirement;
    END IF;
  ELSIF p_owner_kind = 'requirement' THEN
    SELECT site_id INTO v_site FROM public.requirements WHERE id = p_owner_id FOR SHARE;
  ELSIF p_owner_kind = 'workflow' THEN
    SELECT site_id INTO v_site FROM public.instance_plans WHERE id = p_owner_id FOR SHARE;
  ELSE RAISE EXCEPTION 'Invalid sandbox billing owner'; END IF;
  IF v_site IS NULL OR (p_site_id IS NOT NULL AND p_site_id <> v_site) THEN
    RAISE EXCEPTION 'Sandbox billing site ownership mismatch';
  END IF;
  INSERT INTO public.sandbox_billing_resources(sandbox_name,site_id,owner_kind,owner_id)
    VALUES(p_sandbox_name,v_site,p_owner_kind,p_owner_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.sandbox_billing_resources WHERE sandbox_name = p_sandbox_name FOR UPDATE;
  -- A requirement may adopt an earlier harness occurrence on its own site.
  -- Identity is site-immutable; repeated registration never moves the floor.
  IF r.site_id <> v_site THEN RAISE EXCEPTION 'Sandbox billing identity conflict'; END IF;
  IF r.owner_kind <> p_owner_kind OR r.owner_id <> p_owner_id THEN
    RAISE EXCEPTION 'Sandbox billing owner identity conflict';
  END IF;
  IF r.deletion_requested_at IS NOT NULL AND r.retired_at IS NULL THEN
    RAISE EXCEPTION 'Sandbox deletion is pending';
  END IF;
  PERFORM public.renew_site_plan_credits(v_site);
  SELECT credits_available INTO v_available FROM public.billing WHERE site_id=v_site FOR UPDATE;
  IF v_available IS NULL OR v_available <= 0 THEN
    RETURN jsonb_build_object('success',false,'error','Sandbox requires available credits');
  END IF;
  UPDATE public.sandbox_billing_resources SET deletion_requested_at=NULL,retired_at=NULL WHERE sandbox_name=p_sandbox_name;
  RETURN jsonb_build_object('success',true,'site_id',r.site_id,'registered_at',r.registered_at);
END;
$$;

CREATE FUNCTION public.bill_sandbox_sessions(p_sandbox_name text, p_sessions jsonb,
  p_observed_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.sandbox_billing_resources%ROWTYPE; s public.sandbox_billing_sessions%ROWTYPE;
  item jsonb; v_id text; v_start timestamptz; v_end timestamptz; v_until timestamptz;
  v_from timestamptz; v_amount numeric; v_total numeric := 0; result jsonb;
BEGIN
  IF p_observed_at IS NULL OR NOT isfinite(p_observed_at)
    OR p_observed_at > clock_timestamp() + interval '5 seconds'
    OR jsonb_typeof(p_sessions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_sessions) > 1000 THEN
    RAISE EXCEPTION 'Invalid sandbox session observation';
  END IF;
  SELECT * INTO r FROM public.sandbox_billing_resources WHERE sandbox_name = p_sandbox_name FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',true,'outcome','untracked','credits_charged',0); END IF;
  -- One resource row serializes cron/stop/recovery requests. The global session
  -- primary key prevents one actual VM being assigned to two billing resources.
  FOR item IN SELECT value FROM jsonb_array_elements(p_sessions) LOOP
    v_id := item->>'id';
    v_start := (item->>'started_at')::timestamptz;
    v_end := (item->>'ended_at')::timestamptz;
    IF v_id IS NULL OR length(v_id) NOT BETWEEN 1 AND 200 OR v_start IS NULL OR NOT isfinite(v_start)
      OR (v_end IS NOT NULL AND (NOT isfinite(v_end) OR v_end < v_start)) THEN
      RAISE EXCEPTION 'Invalid VM session interval';
    END IF;
    v_until := least(coalesce(v_end,p_observed_at),p_observed_at,clock_timestamp());
    -- Entire old sessions are not even adopted; stopped time is never included.
    IF v_until <= greatest(v_start,r.registered_at) THEN CONTINUE; END IF;
    INSERT INTO public.sandbox_billing_sessions(session_id,sandbox_name,started_at,billed_through)
      VALUES(v_id,p_sandbox_name,v_start,greatest(v_start,r.registered_at)) ON CONFLICT DO NOTHING;
    SELECT * INTO s FROM public.sandbox_billing_sessions WHERE session_id = v_id FOR UPDATE;
    IF s.sandbox_name <> p_sandbox_name OR s.started_at <> v_start THEN
      RAISE EXCEPTION 'VM session billing identity conflict';
    END IF;
    IF (s.ended_at IS NOT NULL AND v_end IS NOT NULL AND s.ended_at <> v_end)
      OR (v_end IS NOT NULL AND v_end < s.billed_through) THEN
      RAISE EXCEPTION 'VM session terminal interval conflict';
    END IF;
    IF s.ended_at IS NOT NULL THEN v_until := least(v_until,s.ended_at); END IF;
    v_from := s.billed_through;
    IF v_until > v_from THEN
      -- Unbounded numeric: no per-tick rounding, margin, or whole-hour rounding.
      v_amount := extract(epoch FROM (v_until-greatest(v_start,r.registered_at))) * 0.5 / 3600 - s.credits_charged;
      result := public.deduct_credits(r.site_id,v_amount,'sandbox_usage','Active sandbox VM time',
        jsonb_build_object('sandbox_name',p_sandbox_name,'session_id',v_id,
          'from',v_from,'through',v_until,'credits_per_hour',0.5));
      IF NOT coalesce((result->>'success')::boolean,false) THEN
        -- Roll back ALL deductions/watermarks in this batch, preserving payable
        -- intervals for retry after replenishment. No partial/phantom settlement.
        RAISE EXCEPTION 'Sandbox billing requires available credits' USING ERRCODE = 'P0001';
      END IF;
      UPDATE public.sandbox_billing_sessions SET billed_through=v_until,
        credits_charged=credits_charged+v_amount WHERE session_id=v_id;
      v_total := v_total+v_amount;
    END IF;
    IF v_end IS NOT NULL THEN
      UPDATE public.sandbox_billing_sessions SET ended_at=least(coalesce(ended_at,v_end),v_end) WHERE session_id=v_id;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success',true,'credits_charged',v_total);
END;
$$;

-- Only the host calls this after EVERY paginated SDK history page succeeded.
CREATE FUNCTION public.complete_sandbox_billing_observation(p_sandbox_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.sandbox_billing_resources SET last_reconciled_at=clock_timestamp() WHERE sandbox_name=p_sandbox_name;
  RETURN jsonb_build_object('success',true);
END;
$$;

-- Persist deletion intent BEFORE destroying provider history. A lost delete
-- response can be safely completed on an exact provider not_found response only
-- when this intent exists. Unknown disappearance is never forgiven.
CREATE FUNCTION public.retire_sandbox_billing(p_sandbox_name text, p_phase text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.sandbox_billing_resources%ROWTYPE;
BEGIN
  IF p_phase NOT IN ('begin','finish') OR p_phase IS NULL THEN RAISE EXCEPTION 'Invalid sandbox retirement phase'; END IF;
  SELECT * INTO r FROM public.sandbox_billing_resources WHERE sandbox_name=p_sandbox_name FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',true,'outcome','untracked'); END IF;
  IF r.retired_at IS NOT NULL THEN RETURN jsonb_build_object('success',true,'outcome','retired'); END IF;
  IF p_phase='begin' THEN
    IF r.last_reconciled_at IS NULL OR r.last_reconciled_at < clock_timestamp()-interval '1 minute'
      OR EXISTS (SELECT 1 FROM public.sandbox_billing_sessions
      WHERE sandbox_name=p_sandbox_name AND (ended_at IS NULL OR billed_through < ended_at)) THEN
      RAISE EXCEPTION 'Sandbox usage settlement is pending';
    END IF;
    UPDATE public.sandbox_billing_resources SET deletion_requested_at=coalesce(deletion_requested_at,clock_timestamp())
      WHERE sandbox_name=p_sandbox_name;
    RETURN jsonb_build_object('success',true,'outcome','delete_pending');
  END IF;
  IF r.deletion_requested_at IS NULL THEN RETURN jsonb_build_object('success',false,'outcome','unproven_disappearance'); END IF;
  UPDATE public.sandbox_billing_resources SET retired_at=clock_timestamp() WHERE sandbox_name=p_sandbox_name;
  RETURN jsonb_build_object('success',true,'outcome','retired');
END;
$$;
REVOKE ALL ON FUNCTION public.register_sandbox_billing(text,text,uuid,uuid),
  public.bill_sandbox_sessions(text,jsonb,timestamptz),public.retire_sandbox_billing(text,text),
  public.complete_sandbox_billing_observation(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_sandbox_billing(text,text,uuid,uuid),
  public.bill_sandbox_sessions(text,jsonb,timestamptz),public.retire_sandbox_billing(text,text),
  public.complete_sandbox_billing_observation(text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;