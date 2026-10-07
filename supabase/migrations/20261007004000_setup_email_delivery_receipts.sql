BEGIN;
SET LOCAL lock_timeout = '5s';

-- No leases or automatic reclaim: an external send may outlive its worker.
CREATE TABLE public.setup_email_delivery_receipts (
  operation_key text PRIMARY KEY CHECK (length(operation_key) BETWEEN 1 AND 200),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  claim_token uuid NOT NULL,
  state text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','sent','skipped','uncertain')),
  receipt jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  CHECK ((state = 'claimed' AND receipt IS NULL AND finalized_at IS NULL)
    OR (state <> 'claimed' AND receipt IS NOT NULL AND finalized_at IS NOT NULL))
);
ALTER TABLE public.setup_email_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.setup_email_delivery_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.setup_email_delivery_receipts FROM PUBLIC, anon, authenticated, service_role;
-- Operators can inspect durable claims for reconciliation; mutations use RPCs.
GRANT SELECT ON public.setup_email_delivery_receipts TO service_role;

CREATE FUNCTION public.claim_setup_email_delivery(
  p_operation_key text, p_site_id uuid, p_payload jsonb, p_claim_token uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r public.setup_email_delivery_receipts%ROWTYPE;
BEGIN
  IF p_operation_key IS NULL OR length(p_operation_key) NOT BETWEEN 1 AND 200
    OR p_site_id IS NULL OR p_claim_token IS NULL OR p_payload IS NULL
    OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid setup email claim' USING ERRCODE = '22023';
  END IF;
  -- A replay returns its durable result even if configuration later changes.
  SELECT * INTO r FROM public.setup_email_delivery_receipts WHERE operation_key = p_operation_key FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM 1 FROM public.sites WHERE id = p_site_id AND archived_at IS NULL AND user_id IS NOT NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','site_unavailable'); END IF;
    INSERT INTO public.setup_email_delivery_receipts(operation_key,site_id,payload,claim_token)
      VALUES(p_operation_key,p_site_id,p_payload,p_claim_token)
      ON CONFLICT(operation_key) DO NOTHING RETURNING * INTO r;
    IF FOUND THEN RETURN jsonb_build_object('outcome','acquired'); END IF;
    SELECT * INTO r FROM public.setup_email_delivery_receipts WHERE operation_key = p_operation_key FOR UPDATE;
  END IF;
  IF r.site_id <> p_site_id OR r.payload <> p_payload THEN
    RETURN jsonb_build_object('outcome','conflict');
  END IF;
  RETURN jsonb_build_object('outcome',r.state,'receipt',r.receipt);
END;
$$;

CREATE FUNCTION public.finalize_setup_email_delivery(
  p_operation_key text, p_site_id uuid, p_payload jsonb, p_claim_token uuid, p_state text, p_receipt jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r public.setup_email_delivery_receipts%ROWTYPE;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('sent','skipped','uncertain')
    OR p_receipt IS NULL OR jsonb_typeof(p_receipt) <> 'object'
    OR p_receipt->>'status' IS DISTINCT FROM p_state THEN
    RAISE EXCEPTION 'Invalid setup email receipt' USING ERRCODE = '22023';
  END IF;
  IF p_state = 'sent' AND (p_receipt->>'success' IS DISTINCT FROM 'true'
    OR coalesce(btrim(p_receipt->>'messageId'),'') = ''
    OR p_receipt->>'recipient' IS DISTINCT FROM p_payload->>'email'
    OR coalesce(p_receipt->>'sent_at','') = '') THEN
    RAISE EXCEPTION 'Sent receipt requires actual delivery confirmation' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM public.setup_email_delivery_receipts WHERE operation_key = p_operation_key FOR UPDATE;
  IF NOT FOUND OR p_claim_token IS NULL OR r.claim_token <> p_claim_token
    OR p_site_id IS NULL OR r.site_id <> p_site_id OR p_payload IS NULL OR r.payload <> p_payload THEN
    RETURN jsonb_build_object('outcome','conflict');
  END IF;
  -- Same-token uncertain -> sent supports evidence-based operator reconciliation,
  -- never authorizes another send. Terminal success cannot be overwritten.
  IF r.state <> 'claimed' AND NOT (r.state = 'uncertain' AND p_state = 'sent') THEN
    IF r.state = p_state AND r.receipt = p_receipt THEN
      RETURN jsonb_build_object('outcome',r.state,'receipt',r.receipt);
    END IF;
    RETURN jsonb_build_object('outcome','conflict');
  END IF;
  UPDATE public.setup_email_delivery_receipts SET state = p_state, receipt = p_receipt, finalized_at = now()
    WHERE operation_key = p_operation_key;
  RETURN jsonb_build_object('outcome',p_state,'receipt',p_receipt);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_setup_email_delivery(text,uuid,jsonb,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_setup_email_delivery(text,uuid,jsonb,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_setup_email_delivery(text,uuid,jsonb,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_setup_email_delivery(text,uuid,jsonb,uuid,text,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;