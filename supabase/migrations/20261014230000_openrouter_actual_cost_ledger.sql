BEGIN;
SET LOCAL lock_timeout = '5s';

-- Global generation identity prevents charging the same response through two adapters.
CREATE TABLE public.openrouter_generation_charges (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 256),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  provider_cost numeric CHECK (provider_cost >= 0 AND provider_cost::text NOT IN ('NaN','Infinity','-Infinity')),
  amount numeric CHECK (amount >= 0 AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','charged')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  charged_at timestamptz
);
ALTER TABLE public.openrouter_generation_charges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.openrouter_generation_charges FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.bill_openrouter_generation(
  p_site_id uuid, p_event_id text, p_provider_cost numeric, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  charge public.openrouter_generation_charges%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_site_id IS NULL OR p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 256
    OR p_provider_cost < 0
    OR p_provider_cost::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Invalid OpenRouter usage charge';
  END IF;
  -- Serialize first registration as well as retries, before any billing bucket lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('openrouter_generation:' || p_event_id, 0));
  SELECT * INTO charge FROM public.openrouter_generation_charges WHERE event_id = p_event_id FOR UPDATE;
  IF FOUND THEN
    IF charge.site_id <> p_site_id OR (charge.provider_cost IS NOT NULL AND p_provider_cost IS NOT NULL
      AND charge.provider_cost <> p_provider_cost) THEN
      RAISE EXCEPTION 'OpenRouter billing identity conflict';
    END IF;
    IF charge.state = 'charged' THEN RETURN charge.result; END IF;
    IF charge.metadata ? 'harness_reservation_event' THEN
      RETURN jsonb_build_object('success',false,'error','Reserved generation requires reservation reconciliation');
    END IF;
    IF charge.provider_cost IS NULL AND p_provider_cost IS NOT NULL THEN
      UPDATE public.openrouter_generation_charges SET provider_cost=p_provider_cost,amount=p_provider_cost*1.25
        WHERE event_id=p_event_id RETURNING * INTO charge;
    END IF;
  ELSE
    INSERT INTO public.openrouter_generation_charges(event_id,site_id,provider_cost,amount,metadata)
      VALUES(p_event_id,p_site_id,p_provider_cost,p_provider_cost * 1.25,coalesce(p_metadata,'{}'::jsonb))
      RETURNING * INTO charge;
  END IF;
  IF charge.provider_cost IS NULL THEN
    v_result := jsonb_build_object('success',false,'error','Provider cost requires reconciliation');
    UPDATE public.openrouter_generation_charges SET result=v_result WHERE event_id=p_event_id;
    RETURN v_result;
  END IF;
  IF charge.amount = 0 THEN
    v_result := jsonb_build_object('success',true,'charged',0,'provider_cost',charge.provider_cost,'multiplier',1.25);
  ELSE
    v_result := public.deduct_credits(p_site_id,charge.amount,'assistant_tokens','OpenRouter actual usage + 25% markup',
      charge.metadata || jsonb_build_object('provider','openrouter','generation_id',p_event_id,
        'provider_cost',charge.provider_cost,'cost_multiplier',1.25));
  END IF;
  IF v_result->>'success' = 'true' THEN
    v_result := v_result || jsonb_build_object('charged',charge.amount,'provider_cost',charge.provider_cost,'multiplier',1.25);
    UPDATE public.openrouter_generation_charges SET state='charged',result=v_result,charged_at=now() WHERE event_id=p_event_id;
  ELSE
    -- Keep known, unpaid usage for operator reconciliation; never re-run the generation.
    UPDATE public.openrouter_generation_charges SET result=v_result WHERE event_id=p_event_id;
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.bill_openrouter_generation(uuid,text,numeric,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bill_openrouter_generation(uuid,text,numeric,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;