BEGIN;
SET LOCAL lock_timeout = '5s';

-- Observation only: no new charge, reservation, token quota or per-tool gate.
-- One credit is one customer USD under the existing billing policy.
CREATE FUNCTION public.evaluate_requirement_cycle_budget(
  p_requirement_id uuid, p_run_id text, p_generation integer, p_session_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r public.requirements%ROWTYPE;
  model_spent numeric; tool_spent numeric; sandbox_spent numeric; total_spent numeric;
  pending_models integer; exhausted boolean;
BEGIN
  IF public.assert_agent_requirement_run(p_requirement_id,p_run_id,p_generation,p_session_id) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Requirement budget ownership changed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO STRICT r FROM public.requirements WHERE id=p_requirement_id FOR UPDATE;
  IF r.budget IS NULL THEN
    RETURN jsonb_build_object('state','unlimited','budget_usd',NULL);
  END IF;
  IF r.budget < 0 OR r.budget::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Invalid requirement monetary budget';
  END IF;

  -- Final customer charge only. Never add admission holds and refunds again.
  SELECT coalesce(sum(charged) FILTER (WHERE state='settled'),0),
    count(*) FILTER (WHERE state IN ('reserved','dispatched','pending'))
    INTO model_spent,pending_models
    FROM public.harness_model_credit_reservations
    WHERE requirement_id=r.id AND site_id=r.site_id;

  -- Disjoint indexable branches preserve the original OR semantics without
  -- scanning the site's whole ledger or deduplicating equal-valued charges.
  SELECT greatest(0,coalesce(-sum(charges.amount),0)) INTO tool_spent
    FROM (
      SELECT t.amount FROM public.credit_transactions t
      WHERE t.site_id=r.site_id AND t.metadata->>'requirement_id'=r.id::text
        AND t.transaction_type NOT IN ('sandbox_usage','agent_model_reservation',
          'agent_model_refund','agent_model_refund_expired','agent_model_settlement','agent_model_actual_cost')
      UNION ALL
      SELECT t.amount FROM public.harness_sessions s
      JOIN public.credit_transactions t ON t.site_id=s.site_id AND t.metadata->>'session_id'=s.id::text
      WHERE s.site_id=r.site_id AND s.snapshot#>>'{request,requirementId}'=r.id::text
        -- An explicit requirement wins; session attribution is legacy fallback.
        AND t.metadata->>'requirement_id' IS NULL
        AND t.transaction_type NOT IN ('sandbox_usage','agent_model_reservation',
          'agent_model_refund','agent_model_refund_expired','agent_model_settlement','agent_model_actual_cost')
    ) charges;

  -- Provider VM session IDs are not harness session UUIDs. Resource ownership
  -- supplies the association; billed totals exclude the VM's stopped time.
  SELECT coalesce(sum(s.credits_charged),0) INTO sandbox_spent
    FROM public.sandbox_billing_sessions s
    JOIN public.sandbox_billing_resources b ON b.sandbox_name=s.sandbox_name
    WHERE b.site_id=r.site_id AND b.owner_kind='requirement' AND b.owner_id=r.id;
  total_spent:=model_spent+tool_spent+sandbox_spent;
  exhausted:=total_spent >= r.budget;
  IF exhausted THEN
    -- The existing cycle transition preserves concurrent pauses/holds and records
    -- the durable blocked projection. No counters or session history are reset.
    IF public.finish_agent_requirement_cycle(p_requirement_id,p_run_id,p_generation,p_session_id,
      'paused','token_budget_exhausted',
      format('Requirement monetary budget exhausted: %s USD charged / %s USD budget (model %s, tools %s, sandbox %s). Checked at cycle start.',
        total_spent,r.budget,model_spent,tool_spent,sandbox_spent)) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Requirement budget projection ownership changed' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN jsonb_build_object('state',CASE WHEN exhausted THEN 'exhausted' ELSE 'available' END,
    'budget_usd',r.budget,'spent_usd',total_spent,'model_usd',model_spent,
    'tools_usd',tool_spent,'sandbox_usd',sandbox_spent,'pending_model_reservations',pending_models);
END;
$$;
REVOKE ALL ON FUNCTION public.evaluate_requirement_cycle_budget(uuid,text,integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_requirement_cycle_budget(uuid,text,integer,uuid) TO service_role;
COMMIT;