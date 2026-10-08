  BEGIN;
  SET LOCAL lock_timeout = '5s';

  -- A terminal Stripe transition preserves the already-consumed paid credit
  -- window. The Toolbox allowance is assigned by the terminal billing trigger,
  -- but its calendar-month reset must not erase paid usage before that window
  -- ends: cancel -> worker/lazy renewal -> replacement would refill it early.
  CREATE OR REPLACE FUNCTION public.renew_site_plan_credits(p_site_id uuid)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE b public.billing%ROWTYPE; v_month timestamptz; v_start timestamptz; w record;
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
    -- The terminal trigger grants only the Toolbox allowance and retains the
    -- previous paid window/usage. Keep that boundary even when the calendar month
    -- changes. A replacement invoice reads this usage under the same billing lock.
    IF b.plan_credit_anchor IS NOT NULL AND b.plan_credit_period_end > now() THEN
      RETURN jsonb_build_object('success',true,'outcome','not_due','credits_granted',0,
        'credits_available',b.credits_available);
    END IF;
    v_month := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    -- Once the preserved window ends, begin the remaining Toolbox month no
    -- earlier than that boundary. The next expiry stays on the UTC month-end,
    -- not a shifted anniversary of the old Stripe subscription.
    v_start := CASE WHEN b.plan_credit_anchor IS NOT NULL AND b.plan_credit_period_end IS NOT NULL
      THEN greatest(v_month,b.plan_credit_period_end) ELSE v_month END;
    RETURN public.reset_site_plan_credit_period(p_site_id,v_start,(v_month AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC',
      public.site_plan_credit_allowance(b.plan,b.addons_count),'workflow');
  END;
  $$;

  COMMIT;