BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.harness_requirement_credit_reservations (
  session_id uuid NOT NULL,
  event_id uuid NOT NULL,
  requirement_id uuid NOT NULL REFERENCES public.requirements(id) ON DELETE CASCADE,
  amount numeric NOT NULL CHECK (amount > 0 AND amount <= 1000),
  result jsonb NOT NULL,
  PRIMARY KEY(session_id,event_id)
);
ALTER TABLE public.harness_requirement_credit_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.harness_requirement_credit_reservations FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.reserve_agent_requirement_credits(p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid,p_event_id uuid,p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing jsonb; result jsonb; site uuid;
BEGIN
  IF p_event_id IS NULL OR p_amount IS NULL OR p_amount<=0 OR p_amount>1000 THEN RAISE EXCEPTION 'Invalid credit reservation'; END IF;
  IF NOT public.assert_agent_requirement_run(p_requirement_id,p_run_id,p_generation,p_session_id) THEN RETURN jsonb_build_object('success',false); END IF;
  SELECT r.result INTO existing FROM public.harness_requirement_credit_reservations r WHERE session_id=p_session_id AND event_id=p_event_id;
  IF FOUND THEN RETURN existing; END IF;
  SELECT site_id INTO site FROM public.requirements WHERE id=p_requirement_id;
  SELECT public.deduct_credits(site,p_amount,'usage','Requirement agent model reservation',jsonb_build_object('requirement_id',p_requirement_id,'session_id',p_session_id,'event_id',p_event_id)) INTO result;
  IF result->>'success'='true' THEN
    INSERT INTO public.harness_requirement_credit_reservations VALUES(p_session_id,p_event_id,p_requirement_id,p_amount,result);
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_agent_requirement_credits(uuid,text,integer,uuid,uuid,numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.reserve_agent_requirement_credits(uuid,text,integer,uuid,uuid,numeric) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;