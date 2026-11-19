-- OFFLINE ONLY: exact shared model trial migration, copied from market-fit
-- 20261019220002_startup_trial_model_reservations.sql. No sibling checkout required.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Existing reservations default to zero trial spend: never guess historical funds.
ALTER TABLE public.harness_model_credit_reservations
  ADD COLUMN trial_spent numeric NOT NULL DEFAULT 0,
  ADD COLUMN trial_ends_at timestamptz;
ALTER TABLE public.harness_model_credit_reservations
  DROP CONSTRAINT harness_model_credit_reservations_check;
ALTER TABLE public.harness_model_credit_reservations ADD CONSTRAINT harness_model_credit_reservations_check CHECK (
  plan_spent>=0 AND legacy_spent>=0 AND purchased_spent>=0 AND trial_spent>=0
  AND amount=plan_spent+legacy_spent+purchased_spent+trial_spent
  AND (trial_spent=0 OR (trial_ends_at IS NOT NULL AND isfinite(trial_ends_at)))
);

CREATE OR REPLACE FUNCTION public.hold_harness_model_credits(p_session_id uuid,p_site_id uuid,p_event_id uuid,p_amount numeric,p_requirement_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b public.billing%ROWTYPE; r public.harness_model_credit_reservations%ROWTYPE;
  v_trial numeric; v_plan numeric; v_legacy numeric; v_purchase numeric;
BEGIN
  IF p_session_id IS NULL OR p_site_id IS NULL OR p_event_id IS NULL OR p_amount IS NULL OR p_amount<=0 OR p_amount>1000
    OR p_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid model reservation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('harness-model:'||p_session_id,0));
  PERFORM public.renew_site_plan_credits(p_site_id);
  SELECT * INTO b FROM public.billing WHERE site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false); END IF;
  SELECT * INTO r FROM public.harness_model_credit_reservations WHERE session_id=p_session_id AND event_id=p_event_id;
  IF FOUND THEN
    IF r.site_id<>p_site_id OR r.requirement_id IS DISTINCT FROM p_requirement_id OR r.amount<>p_amount THEN
      RAISE EXCEPTION 'Model reservation identity conflict'; END IF;
    RETURN jsonb_build_object('success',true,'state',r.state);
  END IF;
  IF EXISTS(SELECT 1 FROM public.harness_model_credit_reservations WHERE (session_id=p_session_id
    OR (p_requirement_id IS NOT NULL AND requirement_id=p_requirement_id)) AND state IN ('reserved','dispatched','pending')) THEN
    RETURN jsonb_build_object('success',false,'error','Prior model outcome requires reconciliation'); END IF;
  IF b.credits_available<p_amount THEN RETURN jsonb_build_object('success',false,'error','Insufficient credits'); END IF;
  v_trial:=least(b.trial_credits_available,p_amount);
  v_plan:=least(b.plan_credits_available,p_amount-v_trial);
  v_legacy:=least(b.legacy_credits_available,p_amount-v_trial-v_plan);
  v_purchase:=p_amount-v_trial-v_plan-v_legacy;
  UPDATE public.billing SET trial_credits_available=trial_credits_available-v_trial,
    plan_credits_available=plan_credits_available-v_plan,
    legacy_credits_available=legacy_credits_available-v_legacy,purchased_credits_available=purchased_credits_available-v_purchase,
    credits_available=credits_available-p_amount,credits_used=coalesce(credits_used,0)+p_amount,
    monthly_credits_used=monthly_credits_used+p_amount,plan_credits_used=plan_credits_used+v_plan WHERE id=b.id;
  INSERT INTO public.harness_model_credit_reservations(session_id,event_id,site_id,requirement_id,amount,
    plan_spent,legacy_spent,purchased_spent,period_start,period_end,trial_spent,trial_ends_at)
    VALUES(p_session_id,p_event_id,p_site_id,p_requirement_id,p_amount,v_plan,v_legacy,v_purchase,b.plan_credit_period_start,b.plan_credit_period_end,v_trial,b.trial_ends_at);
  INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
    VALUES(p_site_id,-p_amount,'agent_model_reservation','OpenRouter admission hold (not final price)',jsonb_build_object(
      'session_id',p_session_id,'event_id',p_event_id,'requirement_id',p_requirement_id,
      'trial_credits_spent',v_trial,'plan_credits_spent',v_plan,'legacy_credits_spent',v_legacy,'purchased_credits_spent',v_purchase));
  RETURN jsonb_build_object('success',true,'state','reserved');
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_harness_model_reservation(p_session_id uuid,p_event_id uuid,p_cost numeric,
  p_generation_id text,p_model text,p_cancel_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.harness_model_credit_reservations%ROWTYPE; b public.billing%ROWTYPE;
  v_trial numeric; v_restore_trial numeric; v_charge numeric; v_refund numeric; v_plan numeric; v_legacy numeric; v_purchase numeric;
  v_restore_plan numeric; v_same_period boolean; v_extra jsonb; v_metadata jsonb;
  g public.openrouter_generation_charges%ROWTYPE; v_global_id text; v_already_charged boolean:=false;
BEGIN
  IF p_cost IS NOT NULL AND (p_cost<0 OR p_cost::text IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'Invalid OpenRouter actual cost'; END IF;
  IF p_generation_id IS NOT NULL AND (length(p_generation_id)=0 OR length(p_generation_id)>256) THEN
    RAISE EXCEPTION 'Invalid generation identity'; END IF;
  IF p_model IS NOT NULL AND length(p_model)>500 THEN RAISE EXCEPTION 'Invalid provider model'; END IF;
  IF p_cancel_reason IS NOT NULL AND p_cancel_reason NOT IN ('predispatch','admission_rejected') THEN
    RAISE EXCEPTION 'Invalid cancellation proof'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('harness-model:'||p_session_id,0));
  SELECT * INTO r FROM public.harness_model_credit_reservations WHERE session_id=p_session_id AND event_id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false); END IF;
  IF r.state IN ('settled','cancelled') THEN
    IF (r.state='cancelled') IS DISTINCT FROM (p_cancel_reason IS NOT NULL)
      OR (r.state='settled' AND r.provider_cost IS DISTINCT FROM p_cost)
      OR (p_generation_id IS NOT NULL AND r.generation_id IS DISTINCT FROM p_generation_id) THEN
      RAISE EXCEPTION 'Model settlement identity conflict'; END IF;
    RETURN jsonb_build_object('success',true,'state',r.state,'charged',r.charged);
  END IF;
  IF r.provider_cost IS NOT NULL AND p_cost IS NOT NULL AND r.provider_cost<>p_cost THEN
    RAISE EXCEPTION 'Provider cost conflict'; END IF;
  IF r.generation_id IS NOT NULL AND p_generation_id IS NOT NULL AND r.generation_id<>p_generation_id THEN
    RAISE EXCEPTION 'Provider generation conflict'; END IF;
  IF p_cancel_reason IS NOT NULL AND (r.provider_cost IS NOT NULL OR r.generation_id IS NOT NULL
    OR r.state='pending') THEN RAISE EXCEPTION 'Cannot refund uncertain accepted generation'; END IF;
  IF p_cancel_reason IS NULL AND r.state='reserved' THEN RAISE EXCEPTION 'Model was not dispatched'; END IF;
  UPDATE public.harness_model_credit_reservations SET provider_cost=coalesce(p_cost,provider_cost),
    generation_id=coalesce(p_generation_id,generation_id),model=coalesce(p_model,model)
    WHERE session_id=p_session_id AND event_id=p_event_id;
  IF p_cancel_reason IS NULL THEN
    v_global_id:=coalesce(p_generation_id,r.generation_id,'harness:'||p_event_id);
    -- A previously unknown transport can later disclose its generation ID.
    -- Move its uncharged fallback receipt rather than stranding a pending alias.
    IF v_global_id<>'harness:'||p_event_id THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('openrouter_generation:harness:'||p_event_id,0));
      DELETE FROM public.openrouter_generation_charges WHERE event_id='harness:'||p_event_id
        AND state='pending' AND metadata->>'harness_reservation_event'=p_event_id::text;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('openrouter_generation:'||v_global_id,0));
    SELECT * INTO g FROM public.openrouter_generation_charges WHERE event_id=v_global_id FOR UPDATE;
    IF FOUND THEN
      IF g.site_id<>r.site_id OR (g.provider_cost IS NOT NULL AND coalesce(p_cost,r.provider_cost) IS NOT NULL
        AND g.provider_cost<>coalesce(p_cost,r.provider_cost)) OR (g.metadata ? 'harness_reservation_event'
        AND g.metadata->>'harness_reservation_event'<>p_event_id::text) THEN
        RAISE EXCEPTION 'OpenRouter billing identity conflict'; END IF;
      v_already_charged:=g.state='charged';
      IF NOT v_already_charged THEN
        UPDATE public.openrouter_generation_charges SET provider_cost=coalesce(p_cost,r.provider_cost,provider_cost),
          amount=coalesce(p_cost,r.provider_cost,provider_cost)*1.25,
          metadata=metadata||jsonb_build_object('harness_reservation_event',p_event_id)
          WHERE event_id=v_global_id; END IF;
    ELSE
      INSERT INTO public.openrouter_generation_charges(event_id,site_id,provider_cost,amount,metadata)
        VALUES(v_global_id,r.site_id,coalesce(p_cost,r.provider_cost),coalesce(p_cost,r.provider_cost)*1.25,
          jsonb_build_object('harness_reservation_event',p_event_id));
    END IF;
  END IF;
  IF p_cancel_reason IS NULL AND coalesce(p_cost,r.provider_cost) IS NULL THEN
    UPDATE public.harness_model_credit_reservations SET state='pending' WHERE session_id=p_session_id AND event_id=p_event_id;
    RETURN jsonb_build_object('success',false,'state','pending','error','Actual cost unknown'); END IF;
  v_charge:=CASE WHEN p_cancel_reason IS NOT NULL THEN 0 ELSE coalesce(p_cost,r.provider_cost)*1.25 END;
  IF v_already_charged THEN v_charge:=0; END IF;
  PERFORM public.renew_site_plan_credits(r.site_id);
  SELECT * INTO b FROM public.billing WHERE site_id=r.site_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing row missing for held model work'; END IF;
  v_metadata:=jsonb_build_object('session_id',p_session_id,'event_id',p_event_id,'requirement_id',r.requirement_id,
    'generation_id',coalesce(p_generation_id,r.generation_id),'model',coalesce(p_model,r.model),
    'provider_cost',coalesce(p_cost,r.provider_cost),'multiplier',1.25,'actual_charge',coalesce(p_cost,r.provider_cost)*1.25,
    'already_charged_globally',v_already_charged);
  IF v_charge>r.amount THEN
    v_extra:=public.deduct_credits(r.site_id,v_charge-r.amount,'agent_model_actual_cost',
      'OpenRouter actual cost above admission hold',v_metadata);
    IF v_extra->>'success' IS DISTINCT FROM 'true' THEN
      UPDATE public.harness_model_credit_reservations SET state='pending' WHERE session_id=p_session_id AND event_id=p_event_id;
      RETURN jsonb_build_object('success',false,'state','pending','error','Additional credits required'); END IF;
  END IF;
  v_refund:=greatest(r.amount-v_charge,0);
  -- Preserve spend order trial -> plan -> legacy -> purchased; refund in reverse.
  v_purchase:=least(r.purchased_spent,v_refund);
  v_legacy:=least(r.legacy_spent,v_refund-v_purchase);
  v_plan:=least(r.plan_spent,v_refund-v_purchase-v_legacy);
  v_trial:=v_refund-v_purchase-v_legacy-v_plan;
  v_restore_trial:=CASE WHEN b.trial_ends_at IS NOT DISTINCT FROM r.trial_ends_at
    AND r.trial_ends_at>clock_timestamp() AND b.status='active'
    AND NOT EXISTS(SELECT 1 FROM public.sites WHERE id=r.site_id AND archived_at IS NOT NULL)
    THEN least(v_trial,greatest(50-b.trial_credits_available,0)) ELSE 0 END;
  v_same_period:=b.plan_credit_period_start IS NOT DISTINCT FROM r.period_start
    AND b.plan_credit_period_end IS NOT DISTINCT FROM r.period_end;
  -- Old plan money expires; it never becomes bought/legacy money or a new
  -- month's allowance. Never replenish a revoked/downgraded entitlement either.
  v_restore_plan:=CASE WHEN v_same_period AND r.period_end>clock_timestamp() AND b.status='active'
    AND NOT EXISTS(SELECT 1 FROM public.sites WHERE id=r.site_id AND archived_at IS NOT NULL) THEN
    least(v_plan,greatest(b.plan_credit_allowance-greatest(b.plan_credits_used-v_plan,0)-b.plan_credits_available,0)) ELSE 0 END;
  IF v_refund>0 THEN
    UPDATE public.billing SET trial_credits_available=trial_credits_available+v_restore_trial,
      plan_credits_available=plan_credits_available+v_restore_plan,
      legacy_credits_available=legacy_credits_available+v_legacy,purchased_credits_available=purchased_credits_available+v_purchase,
      credits_available=credits_available+v_restore_trial+v_restore_plan+v_legacy+v_purchase,
      credits_used=greatest(coalesce(credits_used,0)-v_refund,0),
      monthly_credits_used=CASE WHEN v_same_period THEN greatest(monthly_credits_used-v_refund,0) ELSE monthly_credits_used END,
      plan_credits_used=CASE WHEN v_same_period THEN greatest(plan_credits_used-v_plan,0) ELSE plan_credits_used END WHERE id=b.id;
    IF v_restore_trial+v_restore_plan+v_legacy+v_purchase>0 THEN
      INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
        VALUES(r.site_id,v_restore_trial+v_restore_plan+v_legacy+v_purchase,'agent_model_refund','Unused OpenRouter admission hold',
          v_metadata||jsonb_build_object('trial_credits_restored',v_restore_trial,'plan_credits_restored',v_restore_plan,'legacy_credits_restored',v_legacy,
            'purchased_credits_restored',v_purchase,'cancellation_reason',p_cancel_reason)); END IF;
    IF v_plan>v_restore_plan OR v_trial>v_restore_trial THEN
      INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
        VALUES(r.site_id,0,'agent_model_refund_expired','Unused included hold expired with its entitlement',
          v_metadata||jsonb_build_object('expired_trial_refund',v_trial-v_restore_trial,'expired_plan_refund',v_plan-v_restore_plan)); END IF;
  END IF;
  INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
    VALUES(r.site_id,0,'agent_model_settlement','OpenRouter final usage.cost settlement',v_metadata);
  UPDATE public.harness_model_credit_reservations SET state=CASE WHEN p_cancel_reason IS NULL THEN 'settled' ELSE 'cancelled' END,
    charged=CASE WHEN p_cancel_reason IS NULL THEN coalesce(p_cost,r.provider_cost)*1.25 ELSE 0 END,
    settled_at=now() WHERE session_id=p_session_id AND event_id=p_event_id;
  IF p_cancel_reason IS NULL AND NOT v_already_charged THEN
    UPDATE public.openrouter_generation_charges SET state='charged',charged_at=now(),result=jsonb_build_object(
      'success',true,'charged',coalesce(p_cost,r.provider_cost)*1.25,'provider_cost',coalesce(p_cost,r.provider_cost),'multiplier',1.25)
      WHERE event_id=v_global_id;
  END IF;
  RETURN jsonb_build_object('success',true,'state',CASE WHEN p_cancel_reason IS NULL THEN 'settled' ELSE 'cancelled' END,
    'charged',CASE WHEN p_cancel_reason IS NULL THEN coalesce(p_cost,r.provider_cost)*1.25 ELSE 0 END);
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
