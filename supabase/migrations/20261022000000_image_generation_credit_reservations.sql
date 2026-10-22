BEGIN;
SET LOCAL lock_timeout='5s';

-- Requires shared annual coverage and Startup trial schema/writers/renewal repair.
-- No historical images are inferred or backfilled. The tariff remains 0.1/image.
DO $$ BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='billing'
    AND column_name IN ('trial_credits_available','trial_started_at','trial_ends_at','trial_converted_at',
      'billing_interval','paid_subscription_period_end','plan_credit_anchor'))<>7
    OR to_regprocedure('public.guard_startup_trial_billing()') IS NULL THEN
    RAISE EXCEPTION 'Image reservations require shared annual and Startup trial migrations';
  END IF;
END $$;

CREATE TABLE public.image_generation_credit_reservations (
  site_id uuid NOT NULL REFERENCES public.sites(id),
  operation_id text NOT NULL CHECK(operation_id ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  dispatch_token uuid NOT NULL,
  requested_count integer NOT NULL CHECK(requested_count BETWEEN 1 AND 4),
  amount numeric NOT NULL,
  trial_spent numeric NOT NULL,
  plan_spent numeric NOT NULL,
  legacy_spent numeric NOT NULL,
  purchased_spent numeric NOT NULL,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','dispatched','pending','settled','released')),
  actual_count integer CHECK(actual_count BETWEEN 1 AND 4),
  charged numeric,
  generation_id text,
  model text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY(site_id,operation_id),
  CHECK(amount=requested_count*0.1 AND amount=trial_spent+plan_spent+legacy_spent+purchased_spent
    AND trial_spent>=0 AND plan_spent>=0 AND legacy_spent>=0 AND purchased_spent>=0),
  CHECK(charged IS NULL OR (charged>=0 AND charged<=amount AND charged::text NOT IN ('NaN','Infinity','-Infinity')))
);
CREATE UNIQUE INDEX image_generation_receipt_once ON public.image_generation_credit_reservations(generation_id)
  WHERE generation_id IS NOT NULL;
CREATE INDEX image_generation_pending_audit ON public.image_generation_credit_reservations(created_at)
  WHERE state IN ('reserved','dispatched','pending');
ALTER TABLE public.image_generation_credit_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.image_generation_credit_reservations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.image_generation_credit_reservations TO service_role;

CREATE FUNCTION public.hold_image_generation_credits(p_site_id uuid,p_operation_id text,p_request_hash text,p_token uuid,p_count integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b public.billing%ROWTYPE; r public.image_generation_credit_reservations%ROWTYPE;
  v_amount numeric; v_trial numeric; v_plan numeric; v_legacy numeric; v_purchase numeric;
BEGIN
  IF p_site_id IS NULL OR p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{64}$'
    OR p_request_hash IS NULL OR p_request_hash !~ '^[a-f0-9]{64}$' OR p_token IS NULL
    OR p_count IS NULL OR p_count NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'Invalid image reservation'; END IF;
  -- Shared renewal expires trial and renews only the current monthly annual window.
  PERFORM public.renew_site_plan_credits(p_site_id);
  SELECT * INTO b FROM public.billing WHERE site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','BILLING_UNAVAILABLE'); END IF;
  SELECT * INTO r FROM public.image_generation_credit_reservations WHERE site_id=p_site_id AND operation_id=p_operation_id;
  IF FOUND THEN
    IF r.request_hash<>p_request_hash OR r.requested_count<>p_count THEN
      RETURN jsonb_build_object('success',false,'code','IDEMPOTENCY_CONFLICT'); END IF;
    -- Even an undispatched hold is not a new authorization after a lost response.
    RETURN jsonb_build_object('success',true,'created',false,'state',r.state);
  END IF;
  v_amount:=p_count*0.1;
  IF b.credits_available<>b.trial_credits_available+b.plan_credits_available+b.legacy_credits_available+b.purchased_credits_available THEN
    RAISE EXCEPTION 'Image credit bucket aggregate mismatch'; END IF;
  IF b.credits_available<v_amount THEN RETURN jsonb_build_object('success',false,'code','INSUFFICIENT_CREDITS'); END IF;
  v_trial:=least(b.trial_credits_available,v_amount);
  v_plan:=least(b.plan_credits_available,v_amount-v_trial);
  v_legacy:=least(b.legacy_credits_available,v_amount-v_trial-v_plan);
  v_purchase:=v_amount-v_trial-v_plan-v_legacy;
  UPDATE public.billing SET trial_credits_available=trial_credits_available-v_trial,
    plan_credits_available=plan_credits_available-v_plan,legacy_credits_available=legacy_credits_available-v_legacy,
    purchased_credits_available=purchased_credits_available-v_purchase,credits_available=credits_available-v_amount,
    credits_used=coalesce(credits_used,0)+v_amount,monthly_credits_used=monthly_credits_used+v_amount,
    plan_credits_used=plan_credits_used+v_plan WHERE id=b.id;
  INSERT INTO public.image_generation_credit_reservations(site_id,operation_id,request_hash,dispatch_token,requested_count,
    amount,trial_spent,plan_spent,legacy_spent,purchased_spent,trial_started_at,trial_ends_at,period_start,period_end)
    VALUES(p_site_id,p_operation_id,p_request_hash,p_token,p_count,v_amount,v_trial,v_plan,v_legacy,v_purchase,
      b.trial_started_at,b.trial_ends_at,b.plan_credit_period_start,b.plan_credit_period_end);
  INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
    VALUES(p_site_id,-v_amount,'image_generation_hold','Image generation admission hold',jsonb_build_object(
      'operation_id',p_operation_id,'requested_count',p_count,'trial_spent',v_trial,'plan_spent',v_plan,
      'legacy_spent',v_legacy,'purchased_spent',v_purchase));
  RETURN jsonb_build_object('success',true,'created',true,'state','reserved');
END $$;

CREATE FUNCTION public.dispatch_image_generation_reservation(p_site_id uuid,p_operation_id text,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.image_generation_credit_reservations%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.billing WHERE site_id=p_site_id FOR UPDATE;
  SELECT * INTO r FROM public.image_generation_credit_reservations WHERE site_id=p_site_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR r.dispatch_token IS DISTINCT FROM p_token OR r.state<>'reserved' THEN
    RETURN jsonb_build_object('success',false,'code','DISPATCH_NOT_CLAIMED'); END IF;
  UPDATE public.image_generation_credit_reservations SET state='dispatched',dispatched_at=clock_timestamp()
    WHERE site_id=p_site_id AND operation_id=p_operation_id;
  RETURN jsonb_build_object('success',true,'state','dispatched');
END $$;

-- Private implementation shared by settle and trusted confirmed-rejection release.
CREATE FUNCTION public.finish_image_generation_reservation(p_site_id uuid,p_operation_id text,p_token uuid,
  p_count integer,p_reason text,p_generation_id text,p_model text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b public.billing%ROWTYPE; r public.image_generation_credit_reservations%ROWTYPE;
  v_charge numeric; v_refund numeric; v_trial numeric; v_plan numeric; v_legacy numeric; v_purchase numeric;
  v_restore_trial numeric; v_restore_plan numeric; v_same_period boolean; v_metadata jsonb;
BEGIN
  IF (p_reason IS NULL AND (p_count IS NULL OR p_count NOT BETWEEN 1 AND 4))
    OR (p_reason IS NOT NULL AND (p_count IS NOT NULL OR p_reason NOT IN ('not_dispatched','confirmed_admission_rejection')))
    OR (p_generation_id IS NOT NULL AND p_generation_id !~ '^[a-zA-Z0-9_-]{1,200}$')
    OR (p_model IS NOT NULL AND length(p_model)>128) THEN RAISE EXCEPTION 'Invalid image settlement'; END IF;
  PERFORM public.renew_site_plan_credits(p_site_id);
  SELECT * INTO b FROM public.billing WHERE site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Image billing record unavailable'; END IF;
  SELECT * INTO r FROM public.image_generation_credit_reservations WHERE site_id=p_site_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR r.dispatch_token IS DISTINCT FROM p_token THEN RAISE EXCEPTION 'Image reservation not owned'; END IF;
  IF r.state IN ('settled','released') THEN
    IF r.actual_count IS DISTINCT FROM p_count OR r.reason IS DISTINCT FROM p_reason
      OR r.generation_id IS DISTINCT FROM p_generation_id OR r.model IS DISTINCT FROM p_model THEN
      RAISE EXCEPTION 'Image settlement identity conflict'; END IF;
    RETURN jsonb_build_object('success',true,'state',r.state,'charged',r.charged);
  END IF;
  IF p_reason IS NULL AND (r.state NOT IN ('dispatched','pending') OR p_count>r.requested_count) THEN
    RAISE EXCEPTION 'Image settlement requires dispatch and valid output count'; END IF;
  IF p_reason='not_dispatched' AND r.state<>'reserved' THEN
    RAISE EXCEPTION 'Cannot release an uncertain dispatch'; END IF;
  v_charge:=coalesce(p_count,0)*0.1; v_refund:=r.amount-v_charge;
  -- Charge the original bucket order and return only the unused tail, never bought credit fabrication.
  v_trial:=r.trial_spent-least(r.trial_spent,v_charge);
  v_plan:=r.plan_spent-least(r.plan_spent,greatest(v_charge-r.trial_spent,0));
  v_legacy:=r.legacy_spent-least(r.legacy_spent,greatest(v_charge-r.trial_spent-r.plan_spent,0));
  v_purchase:=r.purchased_spent-least(r.purchased_spent,greatest(v_charge-r.trial_spent-r.plan_spent-r.legacy_spent,0));
  v_same_period:=b.plan_credit_period_start IS NOT DISTINCT FROM r.period_start
    AND b.plan_credit_period_end IS NOT DISTINCT FROM r.period_end;
  v_restore_trial:=CASE WHEN b.trial_converted_at IS NULL AND b.trial_started_at=r.trial_started_at
    AND b.trial_ends_at=r.trial_ends_at AND r.trial_ends_at>clock_timestamp() AND b.status='active'
    AND NOT EXISTS(SELECT 1 FROM public.sites WHERE id=r.site_id AND archived_at IS NOT NULL)
    THEN least(v_trial,greatest(50-b.trial_credits_available,0)) ELSE 0 END;
  v_restore_plan:=CASE WHEN v_same_period AND r.period_end>clock_timestamp() AND b.status='active'
    AND NOT EXISTS(SELECT 1 FROM public.sites WHERE id=r.site_id AND archived_at IS NOT NULL)
    THEN least(v_plan,greatest(b.plan_credit_allowance-greatest(b.plan_credits_used-v_plan,0)-b.plan_credits_available,0)) ELSE 0 END;
  v_metadata:=jsonb_build_object('operation_id',p_operation_id,'actual_count',p_count,'charged',v_charge,
    'reason',p_reason,'generation_id',p_generation_id,'model',p_model);
  IF v_refund>0 THEN
    UPDATE public.billing SET trial_credits_available=trial_credits_available+v_restore_trial,
      plan_credits_available=plan_credits_available+v_restore_plan,legacy_credits_available=legacy_credits_available+v_legacy,
      purchased_credits_available=purchased_credits_available+v_purchase,
      credits_available=credits_available+v_restore_trial+v_restore_plan+v_legacy+v_purchase,
      credits_used=greatest(coalesce(credits_used,0)-v_refund,0),
      monthly_credits_used=CASE WHEN v_same_period THEN greatest(monthly_credits_used-v_refund,0) ELSE monthly_credits_used END,
      plan_credits_used=CASE WHEN v_same_period THEN greatest(plan_credits_used-v_plan,0) ELSE plan_credits_used END WHERE id=b.id;
    INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
      VALUES(p_site_id,v_restore_trial+v_restore_plan+v_legacy+v_purchase,'image_generation_release','Unused image admission hold',
        v_metadata||jsonb_build_object('trial_restored',v_restore_trial,'plan_restored',v_restore_plan,
          'legacy_restored',v_legacy,'purchased_restored',v_purchase,
          'expired_trial',v_trial-v_restore_trial,'expired_plan',v_plan-v_restore_plan));
  END IF;
  INSERT INTO public.credit_transactions(site_id,amount,transaction_type,description,metadata)
    VALUES(p_site_id,0,'image_generation_settlement','Image admission final settlement',v_metadata);
  UPDATE public.image_generation_credit_reservations SET state=CASE WHEN p_reason IS NULL THEN 'settled' ELSE 'released' END,
    actual_count=p_count,charged=v_charge,generation_id=p_generation_id,model=p_model,reason=p_reason,finished_at=clock_timestamp()
    WHERE site_id=p_site_id AND operation_id=p_operation_id;
  RETURN jsonb_build_object('success',true,'state',CASE WHEN p_reason IS NULL THEN 'settled' ELSE 'released' END,'charged',v_charge);
END $$;

CREATE FUNCTION public.settle_image_generation_reservation(p_site_id uuid,p_operation_id text,p_token uuid,p_count integer,p_generation_id text,p_model text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT public.finish_image_generation_reservation($1,$2,$3,$4,NULL,$5,$6);
$$;
CREATE FUNCTION public.release_image_generation_reservation(p_site_id uuid,p_operation_id text,p_token uuid,p_reason text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT public.finish_image_generation_reservation($1,$2,$3,NULL,$4,NULL,NULL);
$$;
CREATE FUNCTION public.mark_image_generation_reservation_pending(p_site_id uuid,p_operation_id text,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE public.image_generation_credit_reservations SET state='pending',reason='outcome_uncertain'
    WHERE site_id=p_site_id AND operation_id=p_operation_id AND dispatch_token=p_token AND state IN ('dispatched','pending');
  RETURN jsonb_build_object('success',FOUND);
END $$;

REVOKE ALL ON FUNCTION public.hold_image_generation_credits(uuid,text,text,uuid,integer),
  public.dispatch_image_generation_reservation(uuid,text,uuid),
  public.finish_image_generation_reservation(uuid,text,uuid,integer,text,text,text),
  public.settle_image_generation_reservation(uuid,text,uuid,integer,text,text),
  public.release_image_generation_reservation(uuid,text,uuid,text),
  public.mark_image_generation_reservation_pending(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hold_image_generation_credits(uuid,text,text,uuid,integer),
  public.dispatch_image_generation_reservation(uuid,text,uuid),
  public.settle_image_generation_reservation(uuid,text,uuid,integer,text,text),
  public.release_image_generation_reservation(uuid,text,uuid,text),
  public.mark_image_generation_reservation_pending(uuid,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;