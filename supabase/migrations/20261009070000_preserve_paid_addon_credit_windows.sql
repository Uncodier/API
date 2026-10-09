BEGIN;
SET LOCAL lock_timeout = '5s';

-- Preserve the excess already granted at the previous add-on rate within a paid
-- credit window. New add-ons grant one each; the next window uses only the new
-- canonical allowance. Do not backfill balances, invoices or credit transactions.
CREATE OR REPLACE FUNCTION public.apply_paid_subscription_credit_coverage(p_invoice jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b public.billing%ROWTYPE; w record; r jsonb;
  v_site uuid := (p_invoice->>'site_id')::uuid;
  v_interval text := coalesce(p_invoice->>'billing_interval','month');
  v_start timestamptz := (p_invoice->>'period_start')::timestamptz;
  v_end timestamptz := (p_invoice->>'period_end')::timestamptz;
  v_allowance numeric := public.site_plan_credit_allowance(p_invoice->>'plan',(p_invoice->>'addons_count')::integer);
  v_source text := 'stripe_invoice:' || (p_invoice->>'invoice_id');
  v_anchor timestamptz;
  v_remaining numeric; v_delta numeric;
BEGIN
  IF v_interval NOT IN ('month','year') OR v_start IS NULL OR v_end IS NULL
    OR NOT isfinite(v_start) OR NOT isfinite(v_end) OR v_start > now() OR v_end <= now()
    OR (p_invoice->>'billing_reason' = 'subscription_update'
      AND coalesce((p_invoice->>'coverage_verified')::boolean,false) IS NOT TRUE)
  THEN RAISE EXCEPTION 'Invalid verified paid coverage'; END IF;
  SELECT * INTO b FROM public.billing WHERE site_id = v_site FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice site has no billing record'; END IF;
  IF b.paid_subscription_period_start > v_start
    OR b.paid_subscription_paid_at > (p_invoice->>'paid_at')::timestamptz THEN
    RETURN jsonb_build_object('success',true,'outcome','stale_period','credits_granted',0);
  END IF;
  IF b.paid_subscription_period_start = v_start AND b.paid_subscription_period_end >= v_end
    AND p_invoice->>'billing_reason' <> 'subscription_update' THEN
    RETURN jsonb_build_object('success',true,'outcome','not_due','credits_granted',0);
  END IF;
  -- Bind identity first: the replacement guard intentionally clears prior coverage.
  UPDATE public.billing SET stripe_subscription_id = p_invoice->>'subscription_id' WHERE id = b.id;
  v_anchor := coalesce(b.plan_credit_anchor,CASE WHEN p_invoice->>'billing_reason' = 'subscription_update'
    THEN b.plan_credit_period_start END,v_start);
  IF v_interval = 'year' THEN
    SELECT * INTO w FROM public.subscription_monthly_credit_window(v_anchor,v_end,now());
  ELSE
    SELECT v_start AS period_start,v_end AS period_end INTO w;
  END IF;
  IF b.plan_credit_period_end > now() AND ((b.plan_credit_anchor IS NOT NULL
      AND (v_interval = 'year' OR p_invoice->>'billing_reason' = 'subscription_update'
        OR b.paid_subscription_invoice_id IS NULL))
    OR (p_invoice->>'billing_reason' = 'subscription_update'
      AND b.plan_credit_source LIKE 'stripe%' AND b.plan_credit_source <> 'stripe_unverified')) THEN
    IF b.paid_subscription_invoice_id IS NOT NULL AND b.paid_subscription_plan IS NOT NULL
      AND b.stripe_subscription_id = p_invoice->>'subscription_id' THEN
      -- Carry only the stored excess, not the previous full quota or remaining
      -- balance. Repeated changes retain this same excess and never refill usage.
      v_allowance := v_allowance + greatest(b.plan_credit_allowance -
        public.site_plan_credit_allowance(b.paid_subscription_plan,b.paid_subscription_addons_count),0);
    END IF;
    v_remaining := greatest(v_allowance-b.plan_credits_used,0);
    v_delta := v_remaining-b.plan_credits_available;
    UPDATE public.billing SET plan_credits_available = v_remaining,
      credits_available = v_remaining+purchased_credits_available+legacy_credits_available,
      plan_credit_allowance = v_allowance,
      plan_credit_period_start = b.plan_credit_period_start,
      plan_credit_period_end = greatest(b.plan_credit_period_end,w.period_end),
      plan_credit_source = v_source WHERE id = b.id;
    INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
      VALUES(v_site,v_delta,'plan_credit_adjustment','Paid plan change retaining current usage',
        jsonb_build_object('credit_bucket','plan','source',v_source,'plan_credits_used',b.plan_credits_used));
    -- payments.credits records integer reset grants; the adjustment stays in the ledger.
    r := jsonb_build_object('success',true,'outcome','adjusted','credits_granted',0);
  ELSE
    r := public.reset_site_plan_credit_period(v_site,w.period_start,w.period_end,v_allowance,v_source);
  END IF;
  IF r->>'outcome' <> 'stale_period' THEN
    UPDATE public.billing SET plan = p_invoice->>'plan',addons_count = (p_invoice->>'addons_count')::integer,
      billing_interval = v_interval,paid_subscription_period_start = v_start,paid_subscription_period_end = v_end,
      paid_subscription_invoice_id = p_invoice->>'invoice_id',paid_subscription_plan = p_invoice->>'plan',
      paid_subscription_paid_at = (p_invoice->>'paid_at')::timestamptz,
      plan_credit_anchor = v_anchor,
      paid_subscription_addons_count = (p_invoice->>'addons_count')::integer WHERE id = b.id;
  END IF;
  RETURN r;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_paid_subscription_credit_coverage(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_paid_subscription_credit_coverage(jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;