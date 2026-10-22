-- OFFLINE DEPENDENCY FIXTURE, never a production migration. Reviewed shared
-- market-fit 20261019220000 schema/guard and 20261019233000 renewal contract.
-- Retains the credit-affecting paths; omits unrelated licensing/RLS/signup RPCs.
-- The image migration is executed unchanged. Annual renewal uses real API SQL.
CREATE TABLE public.site_startup_trials (
  primary_owner_id uuid PRIMARY KEY, site_id uuid NOT NULL UNIQUE,
  started_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, converted_at timestamptz
);
ALTER TABLE public.billing ADD COLUMN trial_credits_available numeric NOT NULL DEFAULT 0,
  ADD COLUMN trial_started_at timestamptz, ADD COLUMN trial_ends_at timestamptz,
  ADD COLUMN trial_converted_at timestamptz;
ALTER TABLE public.billing DROP CONSTRAINT billing_credit_buckets_valid;
ALTER TABLE public.billing ADD CONSTRAINT billing_credit_buckets_valid CHECK (
  plan_credits_available>=0 AND purchased_credits_available>=0 AND legacy_credits_available>=0
  AND trial_credits_available>=0 AND trial_credits_available<=50
  AND monthly_credits_used>=0 AND plan_credits_used>=0 AND plan_credit_allowance>=0
  AND credits_available=plan_credits_available+purchased_credits_available+legacy_credits_available+trial_credits_available
  AND credits_available::text NOT IN ('NaN','Infinity','-Infinity')
  AND monthly_credits_used::text NOT IN ('NaN','Infinity','-Infinity')
  AND plan_credits_used::text NOT IN ('NaN','Infinity','-Infinity')
  AND ((trial_started_at IS NULL AND trial_ends_at IS NULL AND trial_credits_available=0)
    OR (trial_started_at IS NOT NULL AND trial_ends_at IS NOT NULL
      AND trial_ends_at=trial_started_at+interval '360 hours' AND isfinite(trial_started_at) AND isfinite(trial_ends_at)))
  AND (trial_converted_at IS NULL OR (isfinite(trial_converted_at) AND trial_credits_available=0))
);
CREATE FUNCTION public.guard_startup_trial_billing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.site_startup_trials%ROWTYPE; v_now timestamptz:=clock_timestamp(); v_expired numeric:=0;
BEGIN
  SELECT * INTO t FROM public.site_startup_trials WHERE site_id=NEW.site_id;
  IF TG_OP='UPDATE' AND OLD.trial_ends_at<=v_now AND (
    (NEW.trial_credits_available<OLD.trial_credits_available AND NEW.credits_used>OLD.credits_used)
    OR NEW.trial_credits_available>OLD.trial_credits_available) THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Trial expired while debit was being admitted; retry';
  END IF;
  IF NEW.trial_converted_at IS NOT NULL AND NEW.trial_converted_at IS DISTINCT FROM t.converted_at THEN
    RAISE EXCEPTION 'Trial conversion projection must match its claim'; END IF;
  IF NEW.trial_started_at IS NOT NULL AND (t.site_id IS NULL OR NEW.trial_started_at<>t.started_at
    OR NEW.trial_ends_at IS DISTINCT FROM t.ends_at) THEN
    RAISE EXCEPTION 'Trial projection must match its immutable claim'; END IF;
  IF t.site_id IS NOT NULL AND t.converted_at IS NULL AND (
    (NEW.stripe_subscription_id IS NOT NULL AND NEW.paid_subscription_invoice_id IS NOT NULL
      AND NEW.paid_subscription_period_start<=v_now AND NEW.paid_subscription_period_end>v_now
      AND (NEW.plan IN ('engine','foundry','enterprise') OR NEW.addons_count>0))
    OR (NEW.stripe_subscription_id IS NULL AND NEW.plan IN ('engine','foundry','enterprise'))) THEN
    UPDATE public.site_startup_trials SET converted_at=v_now WHERE site_id=NEW.site_id;
    t.converted_at:=v_now;
  END IF;
  IF t.converted_at IS NOT NULL THEN
    v_expired:=NEW.trial_credits_available; NEW.trial_converted_at:=t.converted_at;
    NEW.trial_started_at:=NULL; NEW.trial_ends_at:=NULL; NEW.trial_credits_available:=0;
  ELSIF NEW.trial_ends_at<=v_now OR NEW.status IS DISTINCT FROM 'active'
    OR NOT EXISTS(SELECT 1 FROM public.sites WHERE id=NEW.site_id AND archived_at IS NULL) THEN
    v_expired:=NEW.trial_credits_available; NEW.trial_credits_available:=0;
  END IF;
  IF v_expired>0 THEN INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
    VALUES(NEW.site_id,-v_expired,'startup_trial_expiry','Unused Startup trial credits expired',
      jsonb_build_object('credit_bucket','trial')); END IF;
  NEW.credits_available:=NEW.plan_credits_available+NEW.purchased_credits_available+NEW.legacy_credits_available+NEW.trial_credits_available;
  RETURN NEW;
END $$;
CREATE TRIGGER zzzz_guard_startup_trial_billing BEFORE INSERT OR UPDATE ON public.billing
  FOR EACH ROW EXECUTE FUNCTION public.guard_startup_trial_billing();

-- Reviewed shared 20261019220001 classified four-bucket guard (same policies).
CREATE OR REPLACE FUNCTION public.guard_billing_credit_buckets()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
  v_browser boolean:=coalesce(auth.role(),'') IN ('anon','authenticated') OR coalesce(current_setting('role',true),'') IN ('anon','authenticated');
  v_terminal boolean:=lower(coalesce(NEW.subscription_status,'')) IN ('canceled','cancelled','incomplete_expired');
BEGIN
  IF TG_OP='UPDATE' AND NEW.site_id IS DISTINCT FROM OLD.site_id THEN RAISE EXCEPTION 'Billing tenant identity is immutable'; END IF;
  IF TG_OP='UPDATE' AND lower(coalesce(OLD.subscription_status,'')) IN ('canceled','cancelled','incomplete_expired')
    AND NOT v_terminal AND NEW.stripe_subscription_id IS NOT DISTINCT FROM OLD.stripe_subscription_id AND OLD.stripe_subscription_id IS NOT NULL THEN
    RAISE EXCEPTION 'A terminated Stripe subscription cannot be reactivated by a stale event'; END IF;
  IF v_browser AND NOT(EXISTS(SELECT 1 FROM public.sites WHERE id=NEW.site_id AND user_id=auth.uid())
    OR EXISTS(SELECT 1 FROM public.site_ownership WHERE site_id=NEW.site_id AND user_id=auth.uid())
    OR EXISTS(SELECT 1 FROM public.site_members WHERE site_id=NEW.site_id AND user_id=auth.uid() AND status='active' AND role IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'Billing manager authorization required'; END IF;
  IF TG_OP='INSERT' THEN
    IF v_browser THEN RAISE EXCEPTION 'Billing initialization requires the authorized server'; END IF;
    IF coalesce(NEW.credits_available,0)<>NEW.plan_credits_available+NEW.purchased_credits_available+NEW.legacy_credits_available+NEW.trial_credits_available THEN
      RAISE EXCEPTION 'Use initialize_site_billing or a classified credit RPC'; END IF;
  ELSE
    IF v_browser AND ROW(NEW.plan,NEW.credits_available,NEW.credits_used,NEW.account_balance,
      NEW.plan_credits_available,NEW.purchased_credits_available,NEW.legacy_credits_available,NEW.trial_credits_available,
      NEW.monthly_credits_used,NEW.plan_credits_used,NEW.plan_credit_allowance,NEW.plan_credit_period_start,NEW.plan_credit_period_end,
      NEW.subscription_status,NEW.stripe_customer_id,NEW.stripe_subscription_id,NEW.addons_count,NEW.auto_renew,
      NEW.created_at,NEW.subscription_start_date,NEW.subscription_end_date,NEW.subscription_current_period_end,NEW.status,NEW.plan_credit_source)
      IS DISTINCT FROM ROW(OLD.plan,OLD.credits_available,OLD.credits_used,OLD.account_balance,
      OLD.plan_credits_available,OLD.purchased_credits_available,OLD.legacy_credits_available,OLD.trial_credits_available,
      OLD.monthly_credits_used,OLD.plan_credits_used,OLD.plan_credit_allowance,OLD.plan_credit_period_start,OLD.plan_credit_period_end,
      OLD.subscription_status,OLD.stripe_customer_id,OLD.stripe_subscription_id,OLD.addons_count,OLD.auto_renew,
      OLD.created_at,OLD.subscription_start_date,OLD.subscription_end_date,OLD.subscription_current_period_end,OLD.status,OLD.plan_credit_source) THEN
      RAISE EXCEPTION 'Financial billing fields are server managed'; END IF;
    IF NEW.credits_available IS DISTINCT FROM OLD.credits_available
      AND ROW(NEW.plan_credits_available,NEW.purchased_credits_available,NEW.legacy_credits_available,NEW.trial_credits_available)
      IS NOT DISTINCT FROM ROW(OLD.plan_credits_available,OLD.purchased_credits_available,OLD.legacy_credits_available,OLD.trial_credits_available)
      AND NOT(NEW.trial_credits_available>0 AND NEW.credits_available=NEW.plan_credits_available+NEW.purchased_credits_available+NEW.legacy_credits_available) THEN
      RAISE EXCEPTION 'Aggregate-only credit writes are disabled; use a classified credit RPC'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND NOT v_terminal AND NEW.stripe_subscription_id IS NOT NULL AND NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN
    NEW.plan_credit_source:='stripe_unverified';NEW.plan_credits_available:=0; END IF;
  IF v_terminal THEN
    NEW.plan:='commission';NEW.addons_count:=0;NEW.plan_credit_allowance:=1;
    IF TG_OP='INSERT' OR lower(coalesce(OLD.subscription_status,'')) NOT IN ('canceled','cancelled','incomplete_expired') THEN
      NEW.plan_credits_available:=1;NEW.monthly_credits_used:=0;NEW.plan_credits_used:=0;NEW.plan_credit_source:='toolbox';
      NEW.plan_credit_period_start:=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
      NEW.plan_credit_period_end:=(NEW.plan_credit_period_start AT TIME ZONE 'UTC'+interval '1 month') AT TIME ZONE 'UTC';
    END IF;
  ELSIF TG_OP='UPDATE' AND (NEW.plan IS DISTINCT FROM OLD.plan OR NEW.addons_count IS DISTINCT FROM OLD.addons_count) AND NEW.stripe_subscription_id IS NULL THEN
    NEW.plan_credit_allowance:=public.site_plan_credit_allowance(NEW.plan,NEW.addons_count);
    NEW.plan_credits_available:=greatest(NEW.plan_credit_allowance-OLD.plan_credits_used,0);
  END IF;
  NEW.credits_available:=NEW.plan_credits_available+NEW.purchased_credits_available+NEW.legacy_credits_available+NEW.trial_credits_available;
  RETURN NEW;
END $$;

-- Exact repaired shared renewal body: preserves annual monthly window semantics.
CREATE OR REPLACE FUNCTION public.renew_site_plan_credits(p_site_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.billing%ROWTYPE; v_month timestamptz; v_start timestamptz; w record; v_expired numeric;
BEGIN
  SELECT * INTO b FROM public.billing WHERE site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Billing record not found'); END IF;
  IF b.trial_ends_at<=clock_timestamp() AND b.trial_credits_available>0 THEN
    UPDATE public.billing SET trial_credits_available=trial_credits_available WHERE id=b.id RETURNING * INTO b;
  END IF;
  IF EXISTS(SELECT 1 FROM public.sites WHERE id=p_site_id AND archived_at IS NOT NULL)
    OR (coalesce(b.status,'')<>'active' AND lower(coalesce(b.subscription_status,'')) NOT IN ('canceled','cancelled','incomplete_expired')) THEN
    IF b.plan_credits_available>0 THEN
      v_expired:=b.plan_credits_available;
      UPDATE public.billing SET plan_credits_available=0,credits_available=purchased_credits_available+legacy_credits_available
        WHERE id=b.id RETURNING * INTO b;
      INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
        VALUES(p_site_id,-v_expired,'plan_credit_expiry','Inactive included plan allowance',jsonb_build_object('credit_bucket','plan','reason','inactive'));
    END IF;
    RETURN jsonb_build_object('success',true,'outcome','inactive','credits_granted',0,'credits_available',b.credits_available);
  END IF;
  IF b.stripe_subscription_id IS NOT NULL AND lower(coalesce(b.subscription_status,'')) NOT IN ('canceled','cancelled','incomplete_expired') THEN
    IF b.billing_interval='year' AND b.subscription_status='active'
      AND b.paid_subscription_period_start<=now() AND b.paid_subscription_period_end>now() THEN
      IF b.plan_credit_period_end>now() THEN RETURN jsonb_build_object('success',true,'outcome','not_due','credits_granted',0,'credits_available',b.credits_available); END IF;
      SELECT * INTO w FROM public.subscription_monthly_credit_window(coalesce(b.plan_credit_anchor,b.paid_subscription_period_start),b.paid_subscription_period_end,now());
      RETURN public.reset_site_plan_credit_period(p_site_id,w.period_start,w.period_end,
        public.site_plan_credit_allowance(b.paid_subscription_plan,b.paid_subscription_addons_count),'stripe_invoice:'||b.paid_subscription_invoice_id);
    END IF;
    IF (b.plan_credit_period_end<=now() OR b.paid_subscription_period_end<=now()) AND b.plan_credits_available>0 THEN
      INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
        VALUES(p_site_id,-b.plan_credits_available,'plan_credit_expiry','Expired Stripe plan allowance',jsonb_build_object('credit_bucket','plan','period_end',b.plan_credit_period_end));
      UPDATE public.billing SET plan_credits_available=0,credits_available=purchased_credits_available+legacy_credits_available WHERE id=b.id RETURNING * INTO b;
    END IF;
    IF b.paid_subscription_period_end<=now() THEN UPDATE public.billing SET plan='commission',addons_count=0 WHERE id=b.id RETURNING * INTO b; END IF;
    RETURN jsonb_build_object('success',true,'outcome','stripe_managed','credits_granted',0,'credits_available',b.credits_available);
  END IF;
  IF b.plan_credit_anchor IS NOT NULL AND b.plan_credit_period_end>now() THEN
    RETURN jsonb_build_object('success',true,'outcome','not_due','credits_granted',0,'credits_available',b.credits_available); END IF;
  v_month:=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_start:=CASE WHEN b.plan_credit_anchor IS NOT NULL AND b.plan_credit_period_end IS NOT NULL THEN greatest(v_month,b.plan_credit_period_end) ELSE v_month END;
  RETURN public.reset_site_plan_credit_period(p_site_id,v_start,(v_month AT TIME ZONE 'UTC'+interval '1 month') AT TIME ZONE 'UTC',
    public.site_plan_credit_allowance(b.plan,b.addons_count),'workflow');
END $$;