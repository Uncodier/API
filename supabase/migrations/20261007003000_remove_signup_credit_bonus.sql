BEGIN;
SET LOCAL lock_timeout = '5s';

-- New Toolbox accounts receive the current month's allowance, not a bonus.
-- Existing balances and historical payment markers are deliberately untouched.
CREATE OR REPLACE FUNCTION public.initialize_site_billing(p_site_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b public.billing%ROWTYPE;
  v_inserted boolean := false;
  v_grant integer := public.site_plan_credit_allowance('commission', 0)::integer;
  v_month timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  -- Serialize all issuers without conflicting with ledger foreign-key locks.
  PERFORM 1 FROM public.sites WHERE id = p_site_id AND archived_at IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Active site not found'); END IF;
  IF EXISTS (SELECT 1 FROM public.payments WHERE site_id = p_site_id AND payment_method = 'initial_credit') THEN
    v_grant := 0;
  END IF;
  INSERT INTO public.billing(site_id,plan,credits_available,credits_used,status,
    plan_credits_available,plan_credit_allowance,plan_credit_period_start,plan_credit_period_end,plan_credit_source)
    VALUES (p_site_id,'commission',v_grant,0,'active',v_grant,
      public.site_plan_credit_allowance('commission', 0),v_month,
      (v_month AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC','signup')
    ON CONFLICT (site_id) DO NOTHING RETURNING * INTO b;
  v_inserted := FOUND;
  IF NOT v_inserted THEN SELECT * INTO b FROM public.billing WHERE site_id = p_site_id FOR UPDATE; END IF;
  -- The source name stays compatible with same-period verified Stripe upgrades.
  -- A missing marker never authorizes refilling an existing, possibly spent row.
  IF NOT EXISTS (SELECT 1 FROM public.payments WHERE site_id = p_site_id AND payment_method = 'initial_credit') THEN
    INSERT INTO public.payments(site_id,transaction_id,transaction_type,amount,currency,status,payment_method,credits,details)
      VALUES (p_site_id,'initial_credit_' || p_site_id,'credit',0,'USD','completed','initial_credit',
        CASE WHEN v_inserted THEN v_grant ELSE 0 END,
        jsonb_build_object('note','Initial monthly Toolbox allowance','existing_billing',NOT v_inserted,
          'credit_bucket','plan','period_start',v_month,
          'period_end',(v_month AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC'));
  END IF;
  RETURN jsonb_build_object('success',true,'outcome',CASE WHEN v_inserted THEN 'initialized' ELSE 'already_initialized' END,
    'credits_granted',CASE WHEN v_inserted THEN v_grant ELSE 0 END,'billing_id',b.id,'credits_available',b.credits_available);
END;
$$;

REVOKE ALL ON FUNCTION public.initialize_site_billing(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_site_billing(uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;