BEGIN;
SET LOCAL lock_timeout = '5s';

-- A single billing row is the serialization point for every credit operation.
CREATE UNIQUE INDEX IF NOT EXISTS billing_site_id_uidx ON public.billing(site_id);
ALTER TABLE public.billing
  ADD COLUMN plan_credits_available numeric NOT NULL DEFAULT 0,
  ADD COLUMN purchased_credits_available numeric NOT NULL DEFAULT 0,
  ADD COLUMN legacy_credits_available numeric NOT NULL DEFAULT 0,
  ADD COLUMN monthly_credits_used numeric NOT NULL DEFAULT 0,
  ADD COLUMN plan_credits_used numeric NOT NULL DEFAULT 0,
  ADD COLUMN plan_credit_allowance numeric NOT NULL DEFAULT 0,
  ADD COLUMN plan_credit_source text NOT NULL DEFAULT 'migration',
  ADD COLUMN plan_credit_period_start timestamptz,
  ADD COLUMN plan_credit_period_end timestamptz;

CREATE TABLE public.billing_credit_migration_audit (
  site_id uuid PRIMARY KEY REFERENCES public.sites(id),
  previous_plan text,
  previous_subscription_status text,
  previous_credits_available numeric NOT NULL,
  previous_credits_used numeric NOT NULL,
  previous_account_balance numeric NOT NULL,
  protected_purchase_upper_bound numeric NOT NULL,
  protected_unclassified_credits numeric NOT NULL,
  expired_plan_credits numeric NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_credit_migration_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_credit_migration_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.billing_credit_migration_audit TO service_role;

CREATE TABLE public.billing_credit_grant_keys (
  idempotency_key text PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES public.sites(id),
  amount numeric NOT NULL CHECK (amount > 0 AND amount::text NOT IN ('NaN', 'Infinity', '-Infinity')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_credit_grant_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_credit_grant_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.billing_credit_grant_keys TO service_role;

CREATE FUNCTION public.site_plan_credit_allowance(p_plan text, p_addons integer DEFAULT 0)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN CASE lower(trim(p_plan))
    WHEN 'engine' THEN 20 WHEN 'starter' THEN 20
    WHEN 'foundry' THEN 100 WHEN 'startup' THEN 100
    WHEN 'enterprise' THEN 500
    WHEN 'commission' THEN 1 WHEN 'free' THEN 1 WHEN 'toolbox' THEN 1
    ELSE 0 END
    + CASE WHEN lower(trim(p_plan)) IN ('engine','starter','foundry','startup','enterprise')
      THEN greatest(coalesce(p_addons, 0), 0) * 5 ELSE 0 END;
END;
$$;

-- History predates separated balances. Preserve the ENTIRE historical purchased
-- upper bound (up to current saldo), even if some purchases may already be spent.
-- Positive unclassified grants/restores and unexplained saldo remain protected.
-- Never infer a purchase from a subscription invoice; never touch account_balance.
DO $$
DECLARE
  b public.billing%ROWTYPE;
  v_purchase numeric;
  v_other numeric;
  v_known_plan numeric;
  v_remaining numeric;
  v_legacy numeric;
  v_plan numeric;
  v_cap numeric;
  v_canceled boolean;
  v_month timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  FOR b IN SELECT * FROM public.billing ORDER BY site_id FOR UPDATE LOOP
    IF coalesce(b.credits_available, 0) < 0 THEN
      RAISE EXCEPTION 'Negative legacy credits require reconciliation for site %', b.site_id;
    END IF;
    SELECT coalesce(sum(greatest(coalesce(credits, 0), 0)), 0) INTO v_purchase
      FROM public.payments WHERE site_id = b.site_id AND status = 'completed'
        AND transaction_type = 'credits_purchase';
    SELECT coalesce(sum(amount), 0) INTO v_other FROM public.credit_transactions
      WHERE site_id = b.site_id AND amount > 0
        AND transaction_type NOT IN ('stripe_subscription_invoice', 'subscription_renewal_recovery');
    SELECT coalesce(sum(greatest(coalesce(credits, 0), 0)), 0) INTO v_known_plan
      FROM public.payments WHERE site_id = b.site_id AND status = 'completed'
        AND (payment_method IN ('initial_credit','credit_renewal') OR transaction_type = 'subscription');
    -- A free billing row created by API setup can contain an unlogged 30-credit
    -- signup grant. Include that upper bound, not a new grant. This covers 2guia.
    IF lower(b.plan) IN ('free','commission','toolbox') AND EXISTS (
      SELECT 1 FROM public.payments WHERE site_id = b.site_id AND status = 'completed'
        AND payment_method = 'initial_credit' AND credits = 30 AND amount = 0
        AND details->>'note' = 'Initial signup credits (fallback or new)'
        AND created_at > b.created_at
    ) THEN v_known_plan := v_known_plan + 30; END IF;
    v_purchase := least(coalesce(b.credits_available, 0), v_purchase);
    v_remaining := coalesce(b.credits_available, 0) - v_purchase;
    v_legacy := least(v_remaining, greatest(v_other, v_remaining - v_known_plan, 0));
    v_remaining := v_remaining - v_legacy;
    v_canceled := lower(coalesce(b.subscription_status, '')) IN ('canceled','cancelled','incomplete_expired');
    v_cap := public.site_plan_credit_allowance(CASE WHEN v_canceled THEN 'commission' ELSE b.plan END,
      CASE WHEN v_canceled THEN 0 ELSE b.addons_count END);
    -- Keep the one-time signup allowance until the first calendar-month reset.
    IF NOT v_canceled AND b.created_at >= v_month AND lower(b.plan) IN ('free','commission','toolbox')
      THEN v_cap := 30; END IF;
    v_plan := CASE WHEN v_canceled THEN 1 ELSE least(v_remaining, v_cap) END;
    IF NOT v_canceled AND b.stripe_subscription_id IS NOT NULL
      AND (b.subscription_current_period_end IS NULL OR b.subscription_current_period_end <= now()
        OR lower(coalesce(b.subscription_status,'')) <> 'active') THEN
      -- No invented calendar month is evidence that a Stripe period was paid.
      v_plan := 0;
    END IF;
    INSERT INTO public.billing_credit_migration_audit VALUES
      (b.site_id, b.plan, b.subscription_status, coalesce(b.credits_available, 0),
       coalesce(b.credits_used, 0), coalesce(b.account_balance, 0), v_purchase, v_legacy,
       greatest(v_remaining - v_plan, 0), now());
    UPDATE public.billing SET
      plan = CASE WHEN v_canceled OR lower(b.plan) IN ('free','toolbox') THEN 'commission' ELSE plan END,
      addons_count = CASE WHEN v_canceled THEN 0 ELSE addons_count END,
      plan_credits_available = v_plan, purchased_credits_available = v_purchase,
      legacy_credits_available = v_legacy, credits_available = v_plan + v_purchase + v_legacy,
      plan_credit_allowance = public.site_plan_credit_allowance(
        CASE WHEN v_canceled THEN 'commission' ELSE b.plan END, CASE WHEN v_canceled THEN 0 ELSE b.addons_count END),
      plan_credit_source = CASE WHEN v_canceled THEN 'toolbox' WHEN b.stripe_subscription_id IS NOT NULL
        THEN CASE WHEN b.subscription_current_period_end > now() AND lower(coalesce(b.subscription_status,'')) = 'active'
          THEN 'stripe_legacy' ELSE 'stripe_unverified' END
        ELSE 'migration' END,
      plan_credit_period_start = v_month,
      plan_credit_period_end = (v_month AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC',
      monthly_credits_used = 0,plan_credits_used = greatest(v_cap - v_plan,0)
    WHERE id = b.id;
    IF NOT v_canceled AND b.stripe_subscription_id IS NOT NULL
      AND b.subscription_current_period_end > now() THEN
      UPDATE public.billing SET
        plan_credit_period_end = b.subscription_current_period_end,
        plan_credit_period_start = (b.subscription_current_period_end AT TIME ZONE 'UTC' - interval '1 month') AT TIME ZONE 'UTC'
      WHERE id = b.id;
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE public.billing ADD CONSTRAINT billing_credit_buckets_valid CHECK (
  plan_credits_available >= 0 AND purchased_credits_available >= 0 AND legacy_credits_available >= 0
  AND monthly_credits_used >= 0 AND plan_credits_used >= 0 AND plan_credit_allowance >= 0
  AND credits_available = plan_credits_available + purchased_credits_available + legacy_credits_available
  AND credits_available::text NOT IN ('NaN','Infinity','-Infinity')
  AND monthly_credits_used::text NOT IN ('NaN','Infinity','-Infinity')
  AND plan_credits_used::text NOT IN ('NaN','Infinity','-Infinity')
  AND plan_credit_allowance::text NOT IN ('NaN','Infinity','-Infinity')
  AND ((plan_credit_period_start IS NULL AND plan_credit_period_end IS NULL)
    OR (plan_credit_period_start IS NOT NULL AND plan_credit_period_end IS NOT NULL
      AND isfinite(plan_credit_period_start) AND isfinite(plan_credit_period_end)
      AND plan_credit_period_end > plan_credit_period_start))
);
REVOKE DELETE, TRUNCATE ON public.billing FROM PUBLIC, anon, authenticated;

-- Protect financial data even when an older SECURITY DEFINER upsert is called
-- by a browser. Old aggregate-only credit writes fail rather than destroying a
-- purchased balance or reintroducing additive plan renewal.
CREATE FUNCTION public.guard_billing_credit_buckets()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_browser boolean := coalesce(auth.role(), '') IN ('anon','authenticated')
    OR coalesce(current_setting('role',true),'') IN ('anon','authenticated');
  v_terminal boolean := lower(coalesce(NEW.subscription_status, '')) IN ('canceled','cancelled','incomplete_expired');
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    RAISE EXCEPTION 'Billing tenant identity is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND lower(coalesce(OLD.subscription_status,'')) IN ('canceled','cancelled','incomplete_expired')
    AND NOT v_terminal AND NEW.stripe_subscription_id IS NOT DISTINCT FROM OLD.stripe_subscription_id
    AND OLD.stripe_subscription_id IS NOT NULL THEN
    RAISE EXCEPTION 'A terminated Stripe subscription cannot be reactivated by a stale event';
  END IF;
  IF v_browser AND NOT (
    EXISTS (SELECT 1 FROM public.sites WHERE id = NEW.site_id AND user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.site_ownership WHERE site_id = NEW.site_id AND user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.site_members WHERE site_id = NEW.site_id AND user_id = auth.uid()
      AND status = 'active' AND role IN ('owner','admin'))
  ) THEN RAISE EXCEPTION 'Billing manager authorization required'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_browser THEN RAISE EXCEPTION 'Billing initialization requires the authorized server'; END IF;
    IF coalesce(NEW.credits_available, 0) <> NEW.plan_credits_available + NEW.purchased_credits_available + NEW.legacy_credits_available THEN
      RAISE EXCEPTION 'Use initialize_site_billing or a classified credit RPC';
    END IF;
  ELSE
    IF v_browser AND ROW(NEW.plan,NEW.credits_available,NEW.credits_used,NEW.account_balance,
      NEW.plan_credits_available,NEW.purchased_credits_available,NEW.legacy_credits_available,
      NEW.monthly_credits_used,NEW.plan_credits_used,NEW.plan_credit_allowance,NEW.plan_credit_period_start,NEW.plan_credit_period_end,
      NEW.subscription_status,NEW.stripe_customer_id,NEW.stripe_subscription_id,NEW.addons_count,NEW.auto_renew,
      NEW.created_at,NEW.subscription_start_date,NEW.subscription_end_date,NEW.subscription_current_period_end,NEW.status,NEW.plan_credit_source)
      IS DISTINCT FROM ROW(OLD.plan,OLD.credits_available,OLD.credits_used,OLD.account_balance,
      OLD.plan_credits_available,OLD.purchased_credits_available,OLD.legacy_credits_available,
      OLD.monthly_credits_used,OLD.plan_credits_used,OLD.plan_credit_allowance,OLD.plan_credit_period_start,OLD.plan_credit_period_end,
      OLD.subscription_status,OLD.stripe_customer_id,OLD.stripe_subscription_id,OLD.addons_count,OLD.auto_renew,
      OLD.created_at,OLD.subscription_start_date,OLD.subscription_end_date,OLD.subscription_current_period_end,OLD.status,OLD.plan_credit_source)
      THEN RAISE EXCEPTION 'Financial billing fields are server managed'; END IF;
    IF NEW.credits_available IS DISTINCT FROM OLD.credits_available
      AND ROW(NEW.plan_credits_available,NEW.purchased_credits_available,NEW.legacy_credits_available)
        IS NOT DISTINCT FROM ROW(OLD.plan_credits_available,OLD.purchased_credits_available,OLD.legacy_credits_available)
      THEN RAISE EXCEPTION 'Aggregate-only credit writes are disabled; use a classified credit RPC'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT v_terminal AND NEW.stripe_subscription_id IS NOT NULL
    AND NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN
    -- A different verified subscription needs its own paid invoice. Metadata
    -- synchronization does not grant credits or inherit the previous paid period.
    NEW.plan_credit_source := 'stripe_unverified';
    NEW.plan_credits_available := 0;
  END IF;
  IF v_terminal THEN
    NEW.plan := 'commission'; NEW.addons_count := 0; NEW.plan_credit_allowance := 1;
    IF TG_OP = 'INSERT' OR lower(coalesce(OLD.subscription_status,'')) NOT IN ('canceled','cancelled','incomplete_expired') THEN
      NEW.plan_credits_available := 1; NEW.monthly_credits_used := 0; NEW.plan_credits_used := 0;
      NEW.plan_credit_source := 'toolbox';
      NEW.plan_credit_period_start := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
      NEW.plan_credit_period_end := (NEW.plan_credit_period_start AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC';
    END IF;
  ELSIF TG_OP = 'UPDATE' AND (NEW.plan IS DISTINCT FROM OLD.plan OR NEW.addons_count IS DISTINCT FROM OLD.addons_count)
    AND NEW.stripe_subscription_id IS NULL THEN
    -- Server-authorized partner licenses change entitlement without touching
    -- bought money. Repeating the same plan does not refill spent credits.
    NEW.plan_credit_allowance := public.site_plan_credit_allowance(NEW.plan,NEW.addons_count);
    NEW.plan_credits_available := greatest(NEW.plan_credit_allowance - OLD.plan_credits_used,0);
  END IF;
  NEW.credits_available := NEW.plan_credits_available + NEW.purchased_credits_available + NEW.legacy_credits_available;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zz_guard_billing_credit_buckets BEFORE INSERT OR UPDATE ON public.billing
  FOR EACH ROW EXECUTE FUNCTION public.guard_billing_credit_buckets();

CREATE FUNCTION public.initialize_site_billing(p_site_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b public.billing%ROWTYPE;
  v_inserted boolean := false;
  v_grant integer := 30;
  v_month timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  -- Lock the site before the billing row exists; all callers serialize here.
  PERFORM 1 FROM public.sites WHERE id = p_site_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Site not found'); END IF;
  IF EXISTS (SELECT 1 FROM public.payments WHERE site_id = p_site_id AND payment_method = 'initial_credit') THEN
    v_grant := 0;
  END IF;
  INSERT INTO public.billing(site_id,plan,credits_available,credits_used,status,
    plan_credits_available,plan_credit_allowance,plan_credit_period_start,plan_credit_period_end,plan_credit_source)
    VALUES (p_site_id,'commission',v_grant,0,'active',v_grant,1,v_month,(v_month AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC','signup')
    ON CONFLICT (site_id) DO NOTHING RETURNING * INTO b;
  v_inserted := FOUND;
  IF NOT v_inserted THEN SELECT * INTO b FROM public.billing WHERE site_id = p_site_id FOR UPDATE; END IF;
  -- Missing audit payment is not evidence that the existing account needs money.
  IF NOT EXISTS (SELECT 1 FROM public.payments WHERE site_id = p_site_id AND payment_method = 'initial_credit') THEN
    INSERT INTO public.payments(site_id,transaction_id,transaction_type,amount,currency,status,payment_method,credits,details)
      VALUES (p_site_id,'initial_credit_' || p_site_id,'credit',0,'USD','completed','initial_credit',
        CASE WHEN v_inserted THEN v_grant ELSE 0 END,
        jsonb_build_object('note','Atomic signup initialization','existing_billing',NOT v_inserted));
  END IF;
  RETURN jsonb_build_object('success',true,'outcome',CASE WHEN v_inserted THEN 'initialized' ELSE 'already_initialized' END,
    'credits_granted',CASE WHEN v_inserted THEN v_grant ELSE 0 END,'billing_id',b.id,'credits_available',b.credits_available);
END;
$$;

CREATE OR REPLACE FUNCTION public.fetch_sites_needing_billing_initialization()
RETURNS TABLE(site_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id FROM public.sites s WHERE s.archived_at IS NULL AND NOT EXISTS
    (SELECT 1 FROM public.billing b WHERE b.site_id = s.id);
$$;

CREATE FUNCTION public.reset_site_plan_credit_period(p_site_id uuid,p_period_start timestamptz,
  p_period_end timestamptz,p_allowance numeric,p_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.billing%ROWTYPE; v_delta numeric;
BEGIN
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end <= p_period_start
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR p_period_start > now() OR p_period_end <= now()
    OR p_allowance IS NULL OR p_allowance < 0 OR p_allowance::text IN ('NaN','Infinity','-Infinity')
    OR nullif(p_source,'') IS NULL THEN RAISE EXCEPTION 'Invalid current plan credit period'; END IF;
  SELECT * INTO b FROM public.billing WHERE site_id = p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Billing record not found'); END IF;
  -- Legacy Stripe metadata proves the period END, not its start (month-end
  -- clamping can make end-minus-one-month inaccurate). Invoice replay of that
  -- same paid end must not refill consumed credits, even if its exact start differs.
  IF p_source LIKE 'stripe_invoice:%' AND b.plan_credit_source LIKE 'stripe%'
    AND b.plan_credit_source <> 'stripe_unverified' AND p_period_end <= b.plan_credit_period_end THEN
    RETURN jsonb_build_object('success',true,'outcome',CASE WHEN p_period_end < b.plan_credit_period_end THEN 'stale_period' ELSE 'not_due' END,
      'credits_granted',0,'credits_available',b.credits_available,'expired_credits',0);
  END IF;
  IF b.plan_credit_period_start IS NOT NULL AND p_period_start <= b.plan_credit_period_start
    AND NOT (p_source LIKE 'stripe_invoice:%' AND b.plan_credit_source IN ('signup','stripe_unverified')) THEN
    RETURN jsonb_build_object('success',true,'outcome',CASE WHEN p_period_start < b.plan_credit_period_start THEN 'stale_period' ELSE 'not_due' END,
      'credits_granted',0,'credits_available',b.credits_available,'expired_credits',0);
  END IF;
  v_delta := p_allowance - b.plan_credits_available;
  UPDATE public.billing SET plan_credits_available = p_allowance,
    credits_available = p_allowance + purchased_credits_available + legacy_credits_available,
    plan_credit_allowance = p_allowance,plan_credit_period_start = p_period_start,
    plan_credit_period_end = p_period_end,plan_credit_source = p_source,monthly_credits_used = 0,plan_credits_used = 0 WHERE id = b.id;
  INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
    VALUES (p_site_id,v_delta,'plan_credit_reset','Non-accumulating monthly plan allowance',
      jsonb_build_object('credit_bucket','plan','source',p_source,'period_start',p_period_start,
        'period_end',p_period_end,'allowance',p_allowance,'expired_credits',b.plan_credits_available));
  RETURN jsonb_build_object('success',true,'outcome','reset','credits_granted',p_allowance,
    'credits_available',p_allowance + b.purchased_credits_available + b.legacy_credits_available,
    'expired_credits',b.plan_credits_available);
END;
$$;

CREATE FUNCTION public.renew_site_plan_credits(p_site_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.billing%ROWTYPE; v_month timestamptz;
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
    -- A paid period that ended is not spendable while the next invoice is unpaid
    -- or delayed. A verified new invoice alone can refill this Stripe bucket.
    IF b.plan_credit_period_end <= now() AND b.plan_credits_available > 0 THEN
      UPDATE public.billing SET plan_credits_available = 0,
        credits_available = purchased_credits_available + legacy_credits_available WHERE id = b.id;
      INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
        VALUES (p_site_id,-b.plan_credits_available,'plan_credit_expiry','Expired Stripe plan allowance',
          jsonb_build_object('credit_bucket','plan','period_end',b.plan_credit_period_end));
      b.credits_available := b.purchased_credits_available + b.legacy_credits_available;
    END IF;
    RETURN jsonb_build_object('success',true,'outcome','stripe_managed','credits_granted',0,'credits_available',b.credits_available);
  END IF;
  v_month := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  RETURN public.reset_site_plan_credit_period(p_site_id,v_month,(v_month AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC',
    public.site_plan_credit_allowance(b.plan,b.addons_count),'workflow');
END;
$$;

REVOKE ALL ON FUNCTION public.site_plan_credit_allowance(text,integer),public.guard_billing_credit_buckets(),
  public.initialize_site_billing(uuid),public.fetch_sites_needing_billing_initialization(),
  public.reset_site_plan_credit_period(uuid,timestamptz,timestamptz,numeric,text),public.renew_site_plan_credits(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_site_billing(uuid),public.fetch_sites_needing_billing_initialization(),
  public.reset_site_plan_credit_period(uuid,timestamptz,timestamptz,numeric,text),public.renew_site_plan_credits(uuid),
  public.site_plan_credit_allowance(text,integer)
  TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;