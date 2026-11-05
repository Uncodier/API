BEGIN;
SET LOCAL lock_timeout = '5s';

-- Forward-only function replacement; no balance or historical data changes.
CREATE OR REPLACE FUNCTION public.bill_sandbox_sessions(p_sandbox_name text, p_sessions jsonb,
  p_observed_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.sandbox_billing_resources%ROWTYPE; s public.sandbox_billing_sessions%ROWTYPE;
  item jsonb; v_id text; v_start timestamptz; v_end timestamptz; v_until timestamptz;
  v_from timestamptz; v_amount numeric; v_total numeric := 0; result jsonb;
  v_own_insufficient boolean := false;
BEGIN
  -- This exception block is one subtransaction for the ENTIRE input batch.
  BEGIN
  IF p_observed_at IS NULL OR NOT isfinite(p_observed_at)
    OR p_observed_at > clock_timestamp() + interval '5 seconds'
    OR jsonb_typeof(p_sessions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_sessions) > 1000 THEN
    RAISE EXCEPTION 'Invalid sandbox session observation';
  END IF;
  SELECT * INTO r FROM public.sandbox_billing_resources WHERE sandbox_name = p_sandbox_name FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',true,'outcome','untracked','credits_charged',0); END IF;
  -- One resource row serializes cron/stop/recovery requests. The global session
  -- primary key prevents one actual VM being assigned to two billing resources.
  FOR item IN SELECT value FROM jsonb_array_elements(p_sessions) LOOP
    v_id := item->>'id';
    v_start := (item->>'started_at')::timestamptz;
    v_end := (item->>'ended_at')::timestamptz;
    IF v_id IS NULL OR length(v_id) NOT BETWEEN 1 AND 200 OR v_start IS NULL OR NOT isfinite(v_start)
      OR (v_end IS NOT NULL AND (NOT isfinite(v_end) OR v_end < v_start)) THEN
      RAISE EXCEPTION 'Invalid VM session interval';
    END IF;
    v_until := least(coalesce(v_end,p_observed_at),p_observed_at,clock_timestamp());
    -- Entire old sessions are not even adopted; stopped time is never included.
    IF v_until <= greatest(v_start,r.registered_at) THEN CONTINUE; END IF;
    INSERT INTO public.sandbox_billing_sessions(session_id,sandbox_name,started_at,billed_through)
      VALUES(v_id,p_sandbox_name,v_start,greatest(v_start,r.registered_at)) ON CONFLICT DO NOTHING;
    SELECT * INTO s FROM public.sandbox_billing_sessions WHERE session_id = v_id FOR UPDATE;
    IF s.sandbox_name <> p_sandbox_name OR s.started_at <> v_start THEN
      RAISE EXCEPTION 'VM session billing identity conflict';
    END IF;
    IF (s.ended_at IS NOT NULL AND v_end IS NOT NULL AND s.ended_at <> v_end)
      OR (v_end IS NOT NULL AND v_end < s.billed_through) THEN
      RAISE EXCEPTION 'VM session terminal interval conflict';
    END IF;
    IF s.ended_at IS NOT NULL THEN v_until := least(v_until,s.ended_at); END IF;
    v_from := s.billed_through;
    IF v_until > v_from THEN
      -- Unbounded numeric: no per-tick rounding, margin, or whole-hour rounding.
      v_amount := extract(epoch FROM (v_until-greatest(v_start,r.registered_at))) * 0.5 / 3600 - s.credits_charged;
      result := public.deduct_credits(r.site_id,v_amount,'sandbox_usage','Active sandbox VM time',
        jsonb_build_object('sandbox_name',p_sandbox_name,'session_id',v_id,
          'from',v_from,'through',v_until,'credits_per_hour',0.5));
      IF NOT coalesce((result->>'success')::boolean,false) THEN
        -- Roll back ALL deductions/watermarks in this batch, preserving payable
        -- intervals for retry after replenishment. No partial/phantom settlement.
        IF result->'success' = 'false'::jsonb AND result->>'error' = 'Insufficient credits' THEN
          v_own_insufficient := true;
          RAISE EXCEPTION 'sandbox_batch_insufficient_funding' USING ERRCODE = 'SB001';
        END IF;
        -- Missing billing identity or an unknown/malformed deduction response is
        -- a technical failure, never an expected funding outcome.
        RAISE EXCEPTION 'Sandbox credit deduction failed';
      END IF;
      UPDATE public.sandbox_billing_sessions SET billed_through=v_until,
        credits_charged=credits_charged+v_amount WHERE session_id=v_id;
      v_total := v_total+v_amount;
    END IF;
    IF v_end IS NOT NULL THEN
      UPDATE public.sandbox_billing_sessions SET ended_at=least(coalesce(ended_at,v_end),v_end) WHERE session_id=v_id;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success',true,'credits_charged',v_total);
  EXCEPTION WHEN SQLSTATE 'SB001' THEN
    -- The local flag is set only immediately before our own RAISE. A downstream
    -- exception (even with this SQLSTATE/message) must propagate unchanged.
    IF NOT v_own_insufficient OR SQLERRM <> 'sandbox_batch_insufficient_funding' THEN
      RAISE;
    END IF;
    RETURN jsonb_build_object('success',false,'outcome','insufficient_credits','credits_charged',0);
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.bill_sandbox_sessions(text,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bill_sandbox_sessions(text,jsonb,timestamptz) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
