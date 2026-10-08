BEGIN;
SET LOCAL lock_timeout = '5s';

-- Paid coverage and monthly allowance are independent. No historical payment or
-- balance is guessed/backfilled; old annual accounts need verified reconciliation.
ALTER TABLE public.billing
  ADD COLUMN billing_interval text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month','year')),
  ADD COLUMN paid_subscription_period_start timestamptz,
  ADD COLUMN paid_subscription_period_end timestamptz,
  ADD COLUMN paid_subscription_invoice_id text,
  ADD COLUMN paid_subscription_paid_at timestamptz,
  ADD COLUMN plan_credit_anchor timestamptz CHECK (plan_credit_anchor IS NULL OR isfinite(plan_credit_anchor)),
  ADD COLUMN paid_subscription_plan text,
  ADD COLUMN paid_subscription_addons_count integer;
ALTER TABLE public.billing ADD CONSTRAINT billing_paid_subscription_coverage_valid CHECK (
  (paid_subscription_period_start IS NULL AND paid_subscription_period_end IS NULL
    AND paid_subscription_invoice_id IS NULL AND paid_subscription_plan IS NULL
    AND paid_subscription_addons_count IS NULL AND paid_subscription_paid_at IS NULL)
  OR (paid_subscription_period_start IS NOT NULL AND paid_subscription_period_end IS NOT NULL
    AND isfinite(paid_subscription_period_start) AND isfinite(paid_subscription_period_end)
    AND paid_subscription_period_end > paid_subscription_period_start
    AND paid_subscription_invoice_id IS NOT NULL AND paid_subscription_invoice_id ~ '^in_[A-Za-z0-9]+$'
    AND paid_subscription_paid_at IS NOT NULL AND isfinite(paid_subscription_paid_at)
    AND paid_subscription_plan IS NOT NULL AND paid_subscription_plan IN ('engine','foundry','enterprise')
    AND paid_subscription_addons_count IS NOT NULL AND paid_subscription_addons_count BETWEEN 0 AND 100
    AND stripe_subscription_id IS NOT NULL)
);

-- Financial settlement is immutable; entitlement application can be retried
-- after a nonactive site/subscription recovers, using only this verified payload.
ALTER TABLE public.stripe_subscription_invoice_settlements
  ADD COLUMN verified_credit_coverage jsonb,
  ADD COLUMN credit_coverage_applied boolean NOT NULL DEFAULT false;

-- Keep retired identities even when an old subscription never had an invoice.
-- This also protects historical unconditional server writers from rebinding an
-- obsolete cancellation after a replacement has already committed.
CREATE TABLE public.site_retired_stripe_subscriptions (
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  subscription_id text NOT NULL CHECK (subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(site_id,subscription_id)
);
ALTER TABLE public.site_retired_stripe_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.site_retired_stripe_subscriptions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON TABLE public.site_retired_stripe_subscriptions TO service_role;

CREATE FUNCTION public.fence_retired_stripe_subscription_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN
    IF EXISTS (SELECT 1 FROM public.site_retired_stripe_subscriptions
      WHERE site_id = OLD.site_id AND subscription_id = NEW.stripe_subscription_id) THEN
      RETURN NULL; -- Discard the whole obsolete write before any bucket guard.
    END IF;
    IF OLD.stripe_subscription_id IS NOT NULL THEN
      INSERT INTO public.site_retired_stripe_subscriptions(site_id,subscription_id)
        VALUES(OLD.site_id,OLD.stripe_subscription_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER aa_fence_retired_stripe_subscription_identity BEFORE UPDATE ON public.billing
  FOR EACH ROW EXECUTE FUNCTION public.fence_retired_stripe_subscription_identity();

CREATE FUNCTION public.guard_billing_paid_subscription_coverage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_browser boolean := coalesce(auth.role(),'') IN ('anon','authenticated')
  OR coalesce(current_setting('role',true),'') IN ('anon','authenticated');
BEGIN
  IF TG_OP = 'UPDATE' AND v_browser AND
    ROW(NEW.billing_interval,NEW.paid_subscription_period_start,NEW.paid_subscription_period_end,
      NEW.paid_subscription_invoice_id,NEW.paid_subscription_plan,NEW.paid_subscription_addons_count,NEW.paid_subscription_paid_at,NEW.plan_credit_anchor)
    IS DISTINCT FROM
    ROW(OLD.billing_interval,OLD.paid_subscription_period_start,OLD.paid_subscription_period_end,
      OLD.paid_subscription_invoice_id,OLD.paid_subscription_plan,OLD.paid_subscription_addons_count,OLD.paid_subscription_paid_at,OLD.plan_credit_anchor)
  THEN RAISE EXCEPTION 'Paid subscription coverage is server managed'; END IF;
  IF lower(coalesce(NEW.subscription_status,'')) IN ('canceled','cancelled','incomplete_expired')
    OR (TG_OP = 'UPDATE' AND NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id) THEN
    NEW.paid_subscription_period_start := NULL; NEW.paid_subscription_period_end := NULL;
    NEW.paid_subscription_invoice_id := NULL; NEW.paid_subscription_plan := NULL;
    NEW.paid_subscription_addons_count := NULL;
    NEW.paid_subscription_paid_at := NULL;
    -- Subscription IDs and cancellation are not monthly allowance boundaries.
    -- The earlier bucket guard resets usage on cancellation; retain the paid
    -- window/consumption so cancel -> replacement cannot refill a spent month.
    IF TG_OP = 'UPDATE' AND OLD.plan_credit_anchor IS NOT NULL AND (
      NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
      OR lower(coalesce(OLD.subscription_status,'')) NOT IN ('canceled','cancelled','incomplete_expired')) THEN
      NEW.plan_credit_anchor := OLD.plan_credit_anchor;
      NEW.plan_credit_period_start := OLD.plan_credit_period_start;
      NEW.plan_credit_period_end := OLD.plan_credit_period_end;
      NEW.plan_credits_used := OLD.plan_credits_used;
      NEW.monthly_credits_used := OLD.monthly_credits_used;
    END IF;
    NEW.billing_interval := 'month';
  END IF;
  RETURN NEW;
END;
$$;
-- Run after the existing bucket guard; terminal/subscription replacement clears
-- paid coverage even when invoked through a historical SECURITY DEFINER writer.
CREATE TRIGGER zzz_guard_billing_paid_subscription_coverage BEFORE INSERT OR UPDATE ON public.billing
  FOR EACH ROW EXECUTE FUNCTION public.guard_billing_paid_subscription_coverage();

-- Subscription metadata/status writes must compare the identity read before the
-- Stripe retrieval with the identity under this lock. A stale delete can never
-- bind its obsolete ID again or clear replacement coverage.
CREATE FUNCTION public.sync_stripe_subscription_state(
  p_site_id uuid,p_customer_id text,p_subscription_id text,p_expected_subscription_id text,p_status text,
  p_current_period_end timestamptz DEFAULT NULL,p_start_date timestamptz DEFAULT NULL,
  p_end_date timestamptz DEFAULT NULL,p_auto_renew boolean DEFAULT true,p_invoice_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.billing%ROWTYPE; v_status text := lower(p_status);
  s public.stripe_subscription_invoice_settlements%ROWTYPE;
BEGIN
  IF p_site_id IS NULL OR p_customer_id IS NULL OR p_customer_id !~ '^cus_[A-Za-z0-9]+$'
    OR p_subscription_id IS NULL OR p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    OR (p_expected_subscription_id IS NOT NULL AND p_expected_subscription_id !~ '^sub_[A-Za-z0-9]+$')
    OR v_status IS NULL OR v_status NOT IN
      ('active','trialing','past_due','unpaid','incomplete','paused','canceled','cancelled','incomplete_expired')
    OR (p_current_period_end IS NOT NULL AND NOT isfinite(p_current_period_end))
    OR (p_start_date IS NOT NULL AND NOT isfinite(p_start_date))
    OR (p_end_date IS NOT NULL AND NOT isfinite(p_end_date))
    OR (p_invoice_id IS NOT NULL AND p_invoice_id !~ '^in_[A-Za-z0-9]+$')
  THEN RAISE EXCEPTION 'Invalid verified Stripe subscription state'; END IF;
  SELECT * INTO b FROM public.billing WHERE site_id = p_site_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Subscription site has no billing record'; END IF;
  IF b.stripe_customer_id IS DISTINCT FROM p_customer_id
  THEN RAISE EXCEPTION 'Stripe subscription billing identity mismatch'; END IF;
  IF p_invoice_id IS NOT NULL THEN
    SELECT * INTO s FROM public.stripe_subscription_invoice_settlements WHERE invoice_id = p_invoice_id;
    IF FOUND AND (s.site_id IS DISTINCT FROM p_site_id OR s.customer_id IS DISTINCT FROM p_customer_id
      OR s.subscription_id IS DISTINCT FROM p_subscription_id)
    THEN RAISE EXCEPTION 'Stripe invoice settlement identity mismatch'; END IF;
    -- Settlement and recovery hold this same billing lock when applying the
    -- marker. Reading it here closes the app pre-read -> status-sync race for
    -- both paid and failed retries without suppressing genuine lifecycle events.
    IF s.credit_coverage_applied AND b.stripe_subscription_id = p_subscription_id
      AND b.stripe_subscription_id IS NOT DISTINCT FROM p_expected_subscription_id THEN
      RETURN jsonb_build_object('outcome','synced','subscription_id',p_subscription_id,'invoice_sync_skipped',true);
    END IF;
  END IF;
  IF b.stripe_subscription_id IS DISTINCT FROM p_expected_subscription_id
    OR (b.stripe_subscription_id IS DISTINCT FROM p_subscription_id AND (
      v_status IN ('canceled','cancelled','incomplete_expired')
      OR (b.stripe_subscription_id IS NOT NULL AND lower(coalesce(b.subscription_status,''))
        NOT IN ('canceled','cancelled','incomplete_expired'))
      OR EXISTS (SELECT 1 FROM public.stripe_subscription_invoice_settlements
        WHERE site_id = p_site_id AND subscription_id = p_subscription_id)
      OR EXISTS (SELECT 1 FROM public.site_retired_stripe_subscriptions
        WHERE site_id = p_site_id AND subscription_id = p_subscription_id)))
    OR (b.stripe_subscription_id = p_subscription_id
      AND lower(coalesce(b.subscription_status,'')) IN ('canceled','cancelled','incomplete_expired')
      AND v_status NOT IN ('canceled','cancelled','incomplete_expired')) THEN
    RETURN jsonb_build_object('outcome','obsolete_subscription','subscription_id',b.stripe_subscription_id);
  END IF;
  UPDATE public.billing SET stripe_subscription_id = p_subscription_id,subscription_status = v_status,
    subscription_current_period_end = p_current_period_end,subscription_start_date = p_start_date,
    subscription_end_date = p_end_date,auto_renew = coalesce(p_auto_renew,true),updated_at = now()
    WHERE id = b.id;
  RETURN jsonb_build_object('outcome','synced','subscription_id',p_subscription_id);
END;
$$;

CREATE FUNCTION public.subscription_monthly_credit_window(p_start timestamptz,p_end timestamptz,p_at timestamptz)
RETURNS TABLE(period_start timestamptz,period_end timestamptz)
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE v_index integer; v_start timestamp; v_at timestamp; v_candidate timestamptz;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_at IS NULL OR NOT isfinite(p_start)
    OR NOT isfinite(p_end) OR NOT isfinite(p_at) OR p_end <= p_start OR p_at < p_start OR p_at >= p_end
  THEN RAISE EXCEPTION 'Invalid covered monthly credit window'; END IF;
  v_start := p_start AT TIME ZONE 'UTC'; v_at := p_at AT TIME ZONE 'UTC';
  v_index := (extract(year FROM v_at)::integer-extract(year FROM v_start)::integer)*12
    + extract(month FROM v_at)::integer-extract(month FROM v_start)::integer;
  v_candidate := (v_start + make_interval(months => v_index)) AT TIME ZONE 'UTC';
  IF v_candidate > p_at THEN v_index := v_index - 1; END IF;
  -- Always calculate from the original anchor (Jan 31 -> Feb 28 -> Mar 31),
  -- never from the preceding clamped month or the worker execution timestamp.
  period_start := (v_start + make_interval(months => v_index)) AT TIME ZONE 'UTC';
  period_end := least((v_start + make_interval(months => v_index+1)) AT TIME ZONE 'UTC',p_end);
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_site_plan_credits(p_site_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.billing%ROWTYPE; v_month timestamptz; w record;
BEGIN
  SELECT * INTO b FROM public.billing WHERE site_id = p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Billing record not found'); END IF;
  IF EXISTS (SELECT 1 FROM public.sites WHERE id = p_site_id AND archived_at IS NOT NULL)
    OR (coalesce(b.status,'') <> 'active' AND lower(coalesce(b.subscription_status,'')) NOT IN ('canceled','cancelled','incomplete_expired')) THEN
    IF b.plan_credits_available > 0 THEN
      UPDATE public.billing SET plan_credits_available = 0,
        credits_available = purchased_credits_available + legacy_credits_available WHERE id = b.id;
      INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
        VALUES (p_site_id,-b.plan_credits_available,'plan_credit_expiry','Inactive included plan allowance',
          jsonb_build_object('credit_bucket','plan','reason','inactive'));
      b.credits_available := b.purchased_credits_available + b.legacy_credits_available;
    END IF;
    RETURN jsonb_build_object('success',true,'outcome','inactive','credits_granted',0,'credits_available',b.credits_available);
  END IF;
  IF b.stripe_subscription_id IS NOT NULL AND lower(coalesce(b.subscription_status,'')) NOT IN ('canceled','cancelled','incomplete_expired') THEN
    IF b.billing_interval = 'year' AND b.subscription_status = 'active'
      AND b.paid_subscription_period_start <= now() AND b.paid_subscription_period_end > now() THEN
      IF b.plan_credit_period_end > now() THEN
        RETURN jsonb_build_object('success',true,'outcome','not_due','credits_granted',0,
          'credits_available',b.credits_available);
      END IF;
      SELECT * INTO w FROM public.subscription_monthly_credit_window(
        coalesce(b.plan_credit_anchor,b.paid_subscription_period_start),b.paid_subscription_period_end,now());
      RETURN public.reset_site_plan_credit_period(p_site_id,w.period_start,w.period_end,
        public.site_plan_credit_allowance(b.paid_subscription_plan,b.paid_subscription_addons_count),
        'stripe_invoice:' || b.paid_subscription_invoice_id);
    END IF;
    IF (b.plan_credit_period_end <= now() OR b.paid_subscription_period_end <= now()) AND b.plan_credits_available > 0 THEN
      UPDATE public.billing SET plan_credits_available = 0,
        credits_available = purchased_credits_available + legacy_credits_available WHERE id = b.id;
      INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
        VALUES (p_site_id,-b.plan_credits_available,'plan_credit_expiry','Expired Stripe plan allowance',
          jsonb_build_object('credit_bucket','plan','period_end',b.plan_credit_period_end));
      b.credits_available := b.purchased_credits_available + b.legacy_credits_available;
    END IF;
    IF b.paid_subscription_period_end <= now() THEN
      -- Delayed/missing Stripe renewal events are not proof of paid benefits.
      UPDATE public.billing SET plan='commission',addons_count=0 WHERE id=b.id;
    END IF;
    RETURN jsonb_build_object('success',true,'outcome','stripe_managed','credits_granted',0,'credits_available',b.credits_available);
  END IF;
  v_month := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  RETURN public.reset_site_plan_credit_period(p_site_id,v_month,(v_month AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC',
    public.site_plan_credit_allowance(b.plan,b.addons_count),'workflow');
END;
$$;

-- Called inside invoice settlement, under its billing lock and invoice claim.
CREATE FUNCTION public.apply_paid_subscription_credit_coverage(p_invoice jsonb)
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
    -- Paid interval/plan changes do not erase consumption or replenish spent
    -- allowance. Lowering then raising the quota cannot manufacture credits.
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
    -- payments.credits is an integer initial/reset quota, not a fractional usage
    -- adjustment. The exact adjustment remains in the numeric credit ledger.
    r := jsonb_build_object('success',true,'outcome','adjusted','credits_granted',0);
  ELSE
    r := public.reset_site_plan_credit_period(v_site,w.period_start,w.period_end,v_allowance,v_source);
  END IF;
  -- An old invoice which lost the period comparison must not change entitlement.
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

CREATE OR REPLACE FUNCTION public.settle_stripe_subscription_invoice(p_invoice jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_site uuid := (p_invoice->>'site_id')::uuid;
  v_invoice text := p_invoice->>'invoice_id';
  v_customer text := p_invoice->>'customer_id';
  v_subscription text := p_invoice->>'subscription_id';
  v_status text := p_invoice->>'status';
  v_amount numeric := (p_invoice->>'amount')::numeric;
  v_currency text := p_invoice->>'currency';
  v_plan text := p_invoice->>'plan';
  v_addons integer := (p_invoice->>'addons_count')::integer;
  v_reason text := p_invoice->>'billing_reason';
  v_interval text := coalesce(p_invoice->>'billing_interval','month');
  v_current_status text := lower(nullif(p_invoice->>'current_subscription_status', ''));
  v_period_start timestamptz := nullif(p_invoice->>'period_start', '')::timestamptz;
  v_period_end timestamptz := nullif(p_invoice->>'period_end', '')::timestamptz;
  v_paid_at timestamptz := nullif(p_invoice->>'paid_at', '')::timestamptz;
  v_credits integer := 0;
  v_reset jsonb;
  v_credit_outcome text := 'not_eligible';
  v_billing public.billing%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_settlement public.stripe_subscription_invoice_settlements%ROWTYPE;
  v_details jsonb;
  v_coverage jsonb;
  v_duplicate boolean := false;
  v_applied boolean := false;
BEGIN
  IF jsonb_typeof(p_invoice) IS DISTINCT FROM 'object'
    OR v_site IS NULL OR v_invoice IS NULL OR v_invoice !~ '^in_[A-Za-z0-9]+$'
    OR v_customer IS NULL OR v_customer !~ '^cus_[A-Za-z0-9]+$'
    OR v_subscription IS NULL OR v_subscription !~ '^sub_[A-Za-z0-9]+$'
    OR v_status IS NULL OR v_status NOT IN ('paid', 'failed')
    OR v_amount IS NULL OR v_amount < 0 OR v_amount::text IN ('NaN', 'Infinity', '-Infinity')
    OR v_currency IS NULL OR v_currency !~ '^[A-Z]{3}$'
    OR v_plan IS NULL OR v_plan NOT IN ('engine', 'foundry', 'enterprise')
    OR v_addons IS NULL OR v_addons < 0 OR v_addons > 100
    OR v_interval NOT IN ('month','year')
    OR v_reason IS NULL
    OR (v_current_status IS NOT NULL AND v_current_status NOT IN
      ('active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused', 'canceled', 'cancelled', 'incomplete_expired'))
    OR (v_status = 'paid' AND (v_paid_at IS NULL OR NOT isfinite(v_paid_at)))
    OR ((v_period_start IS NULL) <> (v_period_end IS NULL))
    OR (v_period_start IS NOT NULL AND (NOT isfinite(v_period_start)
      OR NOT isfinite(v_period_end) OR v_period_end <= v_period_start))
    OR (v_reason IN ('subscription_create', 'subscription_cycle') AND v_period_start IS NULL)
    OR (v_status = 'paid' AND v_reason IN ('subscription_create', 'subscription_cycle')
      AND v_period_start > now())
  THEN RAISE EXCEPTION 'Invalid verified Stripe invoice'; END IF;

  -- Same invoice on different sites must serialize before tenant validation.
  PERFORM pg_advisory_xact_lock(hashtextextended('stripe-invoice:' || v_invoice, 0));
  SELECT * INTO v_billing FROM public.billing WHERE site_id = v_site FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice site has no billing record'; END IF;
  IF v_billing.stripe_customer_id IS DISTINCT FROM v_customer
    OR (v_billing.stripe_subscription_id IS NOT NULL
      AND v_billing.stripe_subscription_id <> v_subscription)
    OR EXISTS (SELECT 1 FROM public.site_retired_stripe_subscriptions
      WHERE site_id = v_site AND subscription_id = v_subscription)
  THEN RAISE EXCEPTION 'Stripe invoice billing identity mismatch'; END IF;

  SELECT * INTO v_payment FROM public.payments
    WHERE transaction_id = 'stripe_invoice_' || v_invoice FOR UPDATE;
  IF FOUND AND (v_payment.site_id <> v_site OR v_payment.transaction_type <> 'subscription')
  THEN RAISE EXCEPTION 'Stripe invoice payment identity mismatch'; END IF;

  SELECT * INTO v_settlement FROM public.stripe_subscription_invoice_settlements
    WHERE invoice_id = v_invoice;
  IF FOUND THEN
    IF v_settlement.site_id <> v_site OR v_settlement.customer_id <> v_customer
      OR v_settlement.subscription_id <> v_subscription
      OR (v_status = 'paid' AND (v_settlement.amount <> v_amount OR v_settlement.currency <> v_currency))
    THEN RAISE EXCEPTION 'Stripe invoice settlement identity mismatch'; END IF;
  END IF;

  -- Invoice snapshots are not status updates. In particular a delayed duplicate
  -- paused snapshot cannot poison an active row, or revive a newly paused row.
  -- Status synchronization is a separate expected-subscription-ID fenced RPC.
  IF v_settlement.invoice_id IS NOT NULL THEN
    IF v_status <> 'paid' OR v_settlement.credit_coverage_applied
      OR v_settlement.verified_credit_coverage IS NULL THEN
      RETURN jsonb_build_object('outcome', CASE WHEN v_status = 'paid' THEN 'duplicate' ELSE 'ignored_failure' END,
        'payment_id', v_settlement.payment_id, 'credits_granted', 0);
    END IF;
    v_duplicate := true;
    -- Financial identity was checked above. Never replace settled coverage with
    -- retry-supplied tier, period, reason, interval or paid_at.
    v_coverage := v_settlement.verified_credit_coverage;
    v_period_end := (v_coverage->>'period_end')::timestamptz;
  ELSE
    IF v_status = 'paid' AND (v_reason IN ('subscription_create','subscription_cycle')
      OR (v_reason = 'subscription_update' AND coalesce((p_invoice->>'coverage_verified')::boolean,false))) THEN
      v_coverage := jsonb_build_object('site_id',v_site,'subscription_id',v_subscription,
        'invoice_id',v_invoice,'plan',v_plan,'addons_count',v_addons,'billing_interval',v_interval,
        'billing_reason',v_reason,'period_start',v_period_start,'period_end',v_period_end,
        'paid_at',v_paid_at,'coverage_verified',true);
    END IF;
  END IF;

  IF v_status = 'failed' AND v_payment.status IS NOT NULL AND v_payment.status <> 'failed' THEN
    RETURN jsonb_build_object('outcome', 'ignored_failure', 'payment_id', v_payment.id, 'credits_granted', 0);
  END IF;
  IF NOT v_duplicate AND v_status = 'paid' AND v_payment.status IS NOT NULL AND v_payment.status <> 'failed' THEN
    RAISE EXCEPTION 'Legacy completed invoice requires credit reconciliation';
  END IF;
  IF NOT v_duplicate AND v_status = 'paid' AND EXISTS (
    SELECT 1 FROM public.credit_transactions
    WHERE site_id = v_site AND metadata->>'stripe_invoice_id' = v_invoice AND amount > 0
  ) THEN RAISE EXCEPTION 'Invoice already has historical credits; reconciliation required'; END IF;
  IF NOT v_duplicate AND v_status = 'paid' AND v_reason = 'subscription_create' AND EXISTS (
    SELECT 1 FROM public.payments WHERE site_id = v_site AND status = 'completed'
      AND transaction_type = 'subscription' AND details->>'stripe_subscription_id' = v_subscription
      AND details ? 'stripe_session_id'
  ) THEN RAISE EXCEPTION 'Legacy subscription checkout requires credit reconciliation'; END IF;

  IF v_status = 'paid' AND v_coverage IS NOT NULL THEN
    IF lower(coalesce(v_billing.subscription_status, '')) IN ('canceled', 'cancelled', 'incomplete_expired')
      OR v_current_status IN ('canceled','cancelled','incomplete_expired') THEN
      -- Historical payment is still auditable, but must never resurrect paid
      -- entitlement after the current subscription has terminated.
      v_credit_outcome := 'terminal_subscription';
    ELSIF lower(coalesce(v_billing.subscription_status,'')) <> 'active'
      OR (v_current_status IS NOT NULL AND v_current_status <> 'active') THEN
      v_credit_outcome := 'inactive_subscription';
    ELSIF coalesce(v_billing.status, '') <> 'active' OR EXISTS (
      SELECT 1 FROM public.sites WHERE id = v_site AND archived_at IS NOT NULL
    ) THEN
      v_credit_outcome := 'inactive';
    ELSIF v_period_end <= now() THEN
      -- Do not retry an already expired historical invoice forever. Record it
      -- without a grant rather than asking the current-period helper to reject it.
      v_credit_outcome := 'stale_period';
    ELSIF v_coverage->>'billing_reason' = 'subscription_update' AND (
      p_invoice->'coverage_verified' IS DISTINCT FROM 'true'::jsonb
      OR jsonb_typeof(p_invoice->'current_service') IS DISTINCT FROM 'object'
      OR p_invoice->'current_service'->'plan' IS DISTINCT FROM v_coverage->'plan'
      OR p_invoice->'current_service'->'addons_count' IS DISTINCT FROM v_coverage->'addons_count'
      OR p_invoice->'current_service'->'billing_interval' IS DISTINCT FROM v_coverage->'billing_interval') THEN
      -- Immutable invoice proof does not prove the currently configured service.
      -- Gate by a separate fresh server-verified tuple, never retry-supplied
      -- invoice entitlement, and never overwrite/poison the settled payload.
      v_credit_outcome := 'current_service_mismatch';
    ELSE
      v_reset := public.apply_paid_subscription_credit_coverage(v_coverage);
      IF (v_reset->>'success')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Stripe plan credit reset failed';
      END IF;
      v_credits := (v_reset->>'credits_granted')::integer;
      v_credit_outcome := v_reset->>'outcome';
      v_applied := v_credit_outcome IN ('reset','adjusted','not_due');
    END IF;
  END IF;

  IF v_duplicate THEN
    IF v_applied THEN
      UPDATE public.stripe_subscription_invoice_settlements SET credit_coverage_applied = true,
        credits_granted = credits_granted + v_credits WHERE invoice_id = v_invoice;
      UPDATE public.payments SET credits = coalesce(credits,0) + v_credits,
        details = coalesce(details,'{}'::jsonb) || jsonb_build_object('credit_outcome',v_credit_outcome,
          'credit_coverage_recovered',true),updated_at = now() WHERE id = v_settlement.payment_id;
    END IF;
    RETURN jsonb_build_object('outcome','duplicate','payment_id',v_settlement.payment_id,
      'credits_granted',v_credits,'credit_outcome',v_credit_outcome,'coverage_recovered',v_applied);
  END IF;

  v_details := jsonb_strip_nulls(jsonb_build_object(
    'stripe_invoice_id', v_invoice, 'stripe_subscription_id', v_subscription,
    'stripe_customer_id', v_customer, 'stripe_payment_intent_id', p_invoice->>'payment_intent_id',
    'billing_reason', v_reason, 'plan', v_plan, 'addons_count', v_addons, 'billing_interval', v_interval,
    'stripe_event_id', p_invoice->>'event_id', 'paid_at', p_invoice->>'paid_at',
    'period_start', v_period_start, 'period_end', v_period_end,
    'credit_bucket', 'plan', 'credit_outcome', v_credit_outcome
  ));
  IF v_payment.id IS NULL THEN
    INSERT INTO public.payments(site_id, transaction_id, transaction_type, amount, currency,
      status, payment_method, details, credits, invoice_url)
    VALUES (v_site, 'stripe_invoice_' || v_invoice, 'subscription', v_amount, v_currency,
      CASE WHEN v_status = 'paid' THEN 'completed' ELSE 'failed' END, 'stripe', v_details,
      v_credits, p_invoice->>'invoice_url') RETURNING * INTO v_payment;
  ELSE
    UPDATE public.payments SET amount = v_amount, currency = v_currency,
      status = CASE WHEN v_status = 'paid' THEN 'completed' ELSE 'failed' END,
      details = coalesce(details, '{}'::jsonb) || v_details,
      credits = v_credits, invoice_url = coalesce(p_invoice->>'invoice_url', invoice_url), updated_at = now()
    WHERE id = v_payment.id;
  END IF;
  IF v_status = 'failed' THEN
    RETURN jsonb_build_object('outcome', 'failed_recorded', 'payment_id', v_payment.id, 'credits_granted', 0);
  END IF;

  INSERT INTO public.stripe_subscription_invoice_settlements(invoice_id, site_id, payment_id,
    customer_id, subscription_id, amount, currency, credits_granted, event_id,
    verified_credit_coverage,credit_coverage_applied)
  VALUES (v_invoice, v_site, v_payment.id, v_customer, v_subscription, v_amount, v_currency,
    v_credits, p_invoice->>'event_id',v_coverage,v_applied);
  -- The helper wrote the plan reset ledger atomically. Never also append an
  -- additive subscription grant or change purchased/legacy/account_balance.
  RETURN jsonb_build_object('outcome', 'settled', 'payment_id', v_payment.id, 'credits_granted', v_credits);
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_monthly_credit_window(timestamptz,timestamptz,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_monthly_credit_window(timestamptz,timestamptz,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.renew_site_plan_credits(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_site_plan_credits(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.apply_paid_subscription_credit_coverage(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_paid_subscription_credit_coverage(jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.settle_stripe_subscription_invoice(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_stripe_subscription_invoice(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.sync_stripe_subscription_state(uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,boolean,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_stripe_subscription_state(uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,boolean,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fence_retired_stripe_subscription_identity() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;