BEGIN;
-- Refuse to replace an unexpected admission policy (including a missing wrapper).
DO $$
BEGIN
  IF (SELECT md5(btrim(replace(prosrc, E'\r', ''), E' \t\n')) FROM pg_proc
      WHERE oid = 'public.claim_agent_requirement_run(uuid[],integer,integer,uuid[])'::regprocedure)
      IS DISTINCT FROM '8bf342748f9bb315d4a0c5292d565444' THEN
    RAISE EXCEPTION 'Unexpected requirement claim wrapper; review before migration';
  END IF;
END;
$$;

-- Same identity, arguments, ACL, validation, helper calls and transaction. No
-- telemetry insert (or independent transaction) while admission locks are held.
CREATE OR REPLACE FUNCTION public.claim_agent_requirement_run(
  p_excluded_ids uuid[],p_max_concurrent integer,p_ttl_seconds integer,p_scheduled_ids uuid[] DEFAULT '{}'::uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  t0 timestamptz; t1 timestamptz; t2 timestamptz; t3 timestamptz;
  claim jsonb;
BEGIN
  IF p_max_concurrent IS NULL OR p_max_concurrent NOT BETWEEN 1 AND 100
    OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 86400
    OR cardinality(p_excluded_ids)>10000 OR cardinality(p_scheduled_ids)>10000 THEN
    RAISE EXCEPTION 'Invalid agent cron claim' USING ERRCODE='22023';
  END IF;
  t0 := clock_timestamp();
  PERFORM public.recheck_requirement_economic_pauses(p_excluded_ids);
  t1 := clock_timestamp();
  PERFORM public.apply_pending_requirement_commands();
  t2 := clock_timestamp();
  claim := public.claim_agent_requirement_run_before_commands(p_excluded_ids,p_max_concurrent,p_ttl_seconds,p_scheduled_ids);
  t3 := clock_timestamp();

  -- PostgREST sets request.headers to a JSON object. Direct SQL/older callers
  -- retain the original result, including SQL NULL on an empty queue.
  BEGIN
    IF nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-claim-timings' = '1' THEN
      RETURN jsonb_build_object('claim', claim, 'stage_ms', jsonb_build_object(
        'economic_pause', least(60000, greatest(0, round(extract(epoch FROM t1-t0)*1000))),
        'pending_commands', least(60000, greatest(0, round(extract(epoch FROM t2-t1)*1000))),
        'reservation', least(60000, greatest(0, round(extract(epoch FROM t3-t2)*1000)))));
    END IF;
  EXCEPTION WHEN invalid_text_representation THEN NULL; -- Non-PostgREST caller.
  END;
  RETURN claim;
END;
$$;
COMMIT;
