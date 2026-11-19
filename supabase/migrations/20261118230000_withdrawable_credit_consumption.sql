BEGIN;
SET LOCAL lock_timeout = '5s';

-- Requires the shared Startup trial/annual coverage schema and renewal writers.
-- No balances are transferred, reset or backfilled by this migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='billing' AND column_name='trial_credits_available')
    OR to_regprocedure('public.renew_site_plan_credits(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Withdrawable consumption requires shared classified credit migrations';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.deduct_credits(p_site_id uuid,p_amount numeric,p_type text,
  p_description text,p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.billing%ROWTYPE;
  v_trial numeric; v_plan numeric; v_legacy numeric; v_purchase numeric;
  v_balance numeric; v_regular numeric; v_available numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount::text IN ('NaN','Infinity','-Infinity')
    OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid credit deduction'; END IF;
  -- Renew/expire included funds before admission, under the same billing row lock
  -- used by reservations and the conditional payout debit (deduct_balance).
  PERFORM public.renew_site_plan_credits(p_site_id);
  SELECT * INTO b FROM public.billing WHERE site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Billing record not found'); END IF;
  IF b.credits_available IS NULL OR b.credits_available < 0
    OR b.credits_available::text IN ('NaN','Infinity','-Infinity')
    OR coalesce(b.account_balance,0)::text IN ('NaN','Infinity','-Infinity') THEN
    RETURN jsonb_build_object('success',false,'error','Invalid billing credit balance');
  END IF;
  -- A negative wallet offsets usable funds; it must not be silently ignored.
  v_available := b.credits_available + coalesce(b.account_balance,0);
  IF v_available < p_amount THEN
    RETURN jsonb_build_object('success',false,'error','Insufficient credits','available',v_available,'required',p_amount);
  END IF;
  v_trial := least(b.trial_credits_available,p_amount);
  v_plan := least(b.plan_credits_available,p_amount-v_trial);
  v_legacy := least(b.legacy_credits_available,p_amount-v_trial-v_plan);
  v_purchase := least(b.purchased_credits_available,p_amount-v_trial-v_plan-v_legacy);
  v_regular := v_trial+v_plan+v_legacy+v_purchase;
  v_balance := p_amount-v_regular;
  UPDATE public.billing SET trial_credits_available=trial_credits_available-v_trial,
    plan_credits_available=plan_credits_available-v_plan,
    legacy_credits_available=legacy_credits_available-v_legacy,
    purchased_credits_available=purchased_credits_available-v_purchase,
    credits_available=credits_available-v_regular,
    account_balance=CASE WHEN v_balance>0 THEN account_balance-v_balance ELSE account_balance END,
    credits_used=coalesce(credits_used,0)+p_amount,
    monthly_credits_used=monthly_credits_used+p_amount,plan_credits_used=plan_credits_used+v_plan WHERE id=b.id;
  INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
    VALUES(p_site_id,-p_amount,p_type,p_description,p_metadata||jsonb_build_object(
      'trial_credits_spent',v_trial,'plan_credits_spent',v_plan,'legacy_credits_spent',v_legacy,
      'purchased_credits_spent',v_purchase,'account_balance_spent',v_balance));
  -- Keep remaining's existing regular-credit meaning for older consumers.
  RETURN jsonb_build_object('success',true,'remaining',b.credits_available-v_regular,
    'account_balance',coalesce(b.account_balance,0)-v_balance,'total_available',v_available-p_amount);
END;
$$;

-- Both signatures now share one debit and one ledger entry. In particular, do
-- not debit the wallet again after the classified overload has consumed it.
CREATE OR REPLACE FUNCTION public.deduct_credits(p_site_id uuid,p_credits numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.deduct_credits(p_site_id,p_credits,'credit_usage','Regular credit usage','{}'::jsonb);
  IF NOT coalesce((v_result->>'success')::boolean,false) THEN
    IF v_result->>'error'='Insufficient credits' THEN RAISE EXCEPTION 'Insufficient total usable credits'; END IF;
    IF v_result->>'error'='Billing record not found' THEN RAISE EXCEPTION 'Billing record not found for site'; END IF;
    RAISE EXCEPTION '%',coalesce(v_result->>'error','Credit deduction failed');
  END IF;
  RETURN (v_result->>'remaining')::numeric;
END;
$$;

REVOKE ALL ON FUNCTION public.deduct_credits(uuid,numeric,text,text,jsonb),
  public.deduct_credits(uuid,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_credits(uuid,numeric,text,text,jsonb),
  public.deduct_credits(uuid,numeric) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;