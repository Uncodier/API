BEGIN;
SET LOCAL lock_timeout = '5s';

-- Serialize different tier/interval requests across instances without holding a
-- SQL connection/transaction during Stripe HTTP. A lease is not a payment claim.
CREATE TABLE public.site_subscription_checkout_leases (
  site_id uuid PRIMARY KEY REFERENCES public.sites(id),
  token uuid NOT NULL,
  lease_until timestamptz NOT NULL
);
ALTER TABLE public.site_subscription_checkout_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.site_subscription_checkout_leases FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.site_subscription_checkout_leases TO service_role;

CREATE FUNCTION public.claim_site_subscription_checkout(p_site_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_token uuid := gen_random_uuid(); v_claim uuid;
BEGIN
  IF p_site_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.sites WHERE id=p_site_id AND archived_at IS NULL)
  THEN RAISE EXCEPTION 'Invalid subscription checkout site'; END IF;
  INSERT INTO public.site_subscription_checkout_leases(site_id,token,lease_until)
    VALUES(p_site_id,v_token,clock_timestamp()+interval '5 minutes')
    ON CONFLICT(site_id) DO UPDATE SET token=EXCLUDED.token,lease_until=EXCLUDED.lease_until
      WHERE site_subscription_checkout_leases.lease_until <= clock_timestamp()
    RETURNING token INTO v_claim;
  IF v_claim IS NULL THEN RETURN jsonb_build_object('state','busy','token',NULL); END IF;
  RETURN jsonb_build_object('state','claimed','token',v_claim);
END;
$$;

CREATE FUNCTION public.finish_site_subscription_checkout(p_site_id uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM public.site_subscription_checkout_leases WHERE site_id=p_site_id AND token=p_token;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_site_subscription_checkout(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_site_subscription_checkout(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_site_subscription_checkout(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_site_subscription_checkout(uuid,uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;