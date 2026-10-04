BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.grant_purchased_site_credits(p_site_id uuid,p_amount numeric,
  p_idempotency_key text,p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.billing%ROWTYPE; k public.billing_credit_grant_keys%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount::text IN ('NaN','Infinity','-Infinity')
    OR p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 OR length(p_idempotency_key) > 200
    OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid purchased credit grant'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('purchased_credit:' || p_idempotency_key,0));
  SELECT * INTO b FROM public.billing WHERE site_id = p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Billing record not found'); END IF;
  SELECT * INTO k FROM public.billing_credit_grant_keys WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF k.site_id <> p_site_id OR k.amount <> p_amount THEN RAISE EXCEPTION 'Purchased credit idempotency conflict'; END IF;
    RETURN jsonb_build_object('success',true,'outcome','duplicate','credits_granted',0,'new_balance',b.credits_available);
  END IF;
  -- Older completed checkout payments already delivered their credits. Adopt
  -- their identity without granting a second time when a webhook is replayed.
  IF EXISTS (SELECT 1 FROM public.payments WHERE transaction_id = p_idempotency_key
    AND (site_id <> p_site_id OR coalesce(credits,0) <> p_amount)) THEN
    RAISE EXCEPTION 'Historical purchase identity conflict';
  END IF;
  INSERT INTO public.billing_credit_grant_keys(idempotency_key,site_id,amount)
    VALUES (p_idempotency_key,p_site_id,p_amount);
  IF EXISTS (SELECT 1 FROM public.payments WHERE transaction_id = p_idempotency_key
    AND site_id = p_site_id AND status = 'completed' AND transaction_type = 'credits_purchase') THEN
    RETURN jsonb_build_object('success',true,'outcome','duplicate','credits_granted',0,'new_balance',b.credits_available);
  END IF;
  UPDATE public.billing SET purchased_credits_available = purchased_credits_available + p_amount,
    credits_available = credits_available + p_amount WHERE id = b.id;
  INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
    VALUES (p_site_id,p_amount,'credits_purchase','Purchased non-expiring credits',
      p_metadata || jsonb_build_object('credit_bucket','purchased','idempotency_key',p_idempotency_key));
  RETURN jsonb_build_object('success',true,'outcome','granted','credits_granted',p_amount,'new_balance',b.credits_available + p_amount);
END;
$$;

-- Unclassified refunds/restores are non-expiring. Plan renewal must use the
-- period RPC and purchases must provide a stable purchase identity.
CREATE OR REPLACE FUNCTION public.add_credits(p_site_id uuid,p_amount numeric,p_type text,
  p_description text,p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.billing%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount::text IN ('NaN','Infinity','-Infinity')
    OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid credit amount'; END IF;
  IF p_type IN ('initial_credit','credit_renewal','stripe_subscription_invoice','subscription_renewal_recovery','plan_credit_reset') THEN
    RAISE EXCEPTION 'Plan credits require an idempotent plan-period RPC';
  END IF;
  IF p_type = 'credits_purchase' THEN
    RETURN public.grant_purchased_site_credits(p_site_id,p_amount,p_metadata->>'idempotency_key',p_metadata);
  END IF;
  SELECT * INTO b FROM public.billing WHERE site_id = p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Billing record not found'); END IF;
  UPDATE public.billing SET legacy_credits_available = legacy_credits_available + p_amount,
    credits_available = credits_available + p_amount WHERE id = b.id;
  INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
    VALUES (p_site_id,p_amount,p_type,p_description,p_metadata || jsonb_build_object('credit_bucket','legacy'));
  RETURN jsonb_build_object('success',true,'new_balance',b.credits_available + p_amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.add_credits(p_site_id uuid,p_credits integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Unclassified additive credits are disabled; use a classified idempotent grant RPC';
END;
$$;

CREATE OR REPLACE FUNCTION public.deduct_credits(p_site_id uuid,p_amount numeric,p_type text,
  p_description text,p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.billing%ROWTYPE; v_plan numeric; v_legacy numeric; v_purchase numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount::text IN ('NaN','Infinity','-Infinity')
    OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid credit deduction'; END IF;
  -- Lazy renewal prevents stale included credits being spent before a daily job.
  PERFORM public.renew_site_plan_credits(p_site_id);
  SELECT * INTO b FROM public.billing WHERE site_id = p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Billing record not found'); END IF;
  IF b.credits_available < p_amount THEN
    RETURN jsonb_build_object('success',false,'error','Insufficient credits','available',b.credits_available,'required',p_amount);
  END IF;
  v_plan := least(b.plan_credits_available,p_amount);
  v_legacy := least(b.legacy_credits_available,p_amount - v_plan);
  v_purchase := p_amount - v_plan - v_legacy;
  UPDATE public.billing SET plan_credits_available = plan_credits_available - v_plan,
    legacy_credits_available = legacy_credits_available - v_legacy,
    purchased_credits_available = purchased_credits_available - v_purchase,
    credits_available = credits_available - p_amount,credits_used = coalesce(credits_used,0) + p_amount,
    monthly_credits_used = monthly_credits_used + p_amount,plan_credits_used = plan_credits_used + v_plan WHERE id = b.id;
  INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
    VALUES (p_site_id,-p_amount,p_type,p_description,p_metadata || jsonb_build_object(
      'plan_credits_spent',v_plan,'legacy_credits_spent',v_legacy,'purchased_credits_spent',v_purchase));
  RETURN jsonb_build_object('success',true,'remaining',b.credits_available - p_amount);
END;
$$;

-- This overload retains the existing commerce contract: regular credits first,
-- then the separate withdrawable balance. Monthly reset never modifies balance.
CREATE OR REPLACE FUNCTION public.deduct_credits(p_site_id uuid,p_credits numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.billing%ROWTYPE; v_regular numeric; v_balance numeric; v_result jsonb;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 OR p_credits::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Invalid credit deduction'; END IF;
  PERFORM public.renew_site_plan_credits(p_site_id);
  SELECT * INTO b FROM public.billing WHERE site_id = p_site_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing record not found for site'; END IF;
  IF b.credits_available + coalesce(b.account_balance,0) < p_credits THEN RAISE EXCEPTION 'Insufficient total usable credits'; END IF;
  v_regular := least(b.credits_available,p_credits);
  v_balance := p_credits - v_regular;
  IF v_regular > 0 THEN
    v_result := public.deduct_credits(p_site_id,v_regular,'credit_usage','Regular credit usage','{}'::jsonb);
    IF NOT coalesce((v_result->>'success')::boolean,false) THEN RAISE EXCEPTION 'Regular credit deduction failed'; END IF;
  END IF;
  IF v_balance > 0 THEN
    UPDATE public.billing SET account_balance = account_balance - v_balance,
      credits_used = coalesce(credits_used,0) + v_balance,monthly_credits_used = monthly_credits_used + v_balance WHERE id = b.id;
  END IF;
  RETURN b.credits_available - v_regular;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_purchased_site_credits(uuid,numeric,text,jsonb),
  public.add_credits(uuid,numeric,text,text,jsonb),public.add_credits(uuid,integer),
  public.deduct_credits(uuid,numeric,text,text,jsonb),public.deduct_credits(uuid,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_purchased_site_credits(uuid,numeric,text,jsonb),
  public.add_credits(uuid,numeric,text,text,jsonb),public.deduct_credits(uuid,numeric,text,text,jsonb),
  public.deduct_credits(uuid,numeric) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;