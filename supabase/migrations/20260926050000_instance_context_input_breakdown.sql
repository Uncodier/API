-- Store only aggregate estimates for the prompt actually sent. The existing
-- usage RPCs remain untouched so old API deployments can still write totals.
BEGIN;

ALTER TABLE public.instance_context_state
  ADD COLUMN IF NOT EXISTS input_breakdown jsonb;

CREATE OR REPLACE FUNCTION public.record_instance_context_breakdown(
  p_instance_id uuid, p_site_id uuid, p_model text, p_used_tokens integer,
  p_source text, p_measured_at timestamptz, p_breakdown jsonb
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  -- Never attach a breakdown to a newer/different checkpoint. The writer
  -- sends numbers only; reject unrecognized keys or embedded prompt content.
  IF jsonb_typeof(p_breakdown) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_breakdown)) <> 9
    OR NOT (p_breakdown ?& ARRAY[
      'estimatedInputTokens','instructions','skills','messages','toolCalls',
      'toolDefinitions','usedTokens','source','measuredAt'])
    OR jsonb_typeof(p_breakdown->'usedTokens') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_breakdown->'source') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_breakdown->'measuredAt') IS DISTINCT FROM 'string'
    OR p_breakdown->>'usedTokens' IS DISTINCT FROM p_used_tokens::text
    OR p_breakdown->>'source' IS DISTINCT FROM p_source
    OR p_breakdown->>'measuredAt' IS DISTINCT FROM to_char(p_measured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR EXISTS (SELECT 1 FROM jsonb_each(p_breakdown) AS part(key, value)
      WHERE part.key IN ('estimatedInputTokens','instructions','skills','messages','toolCalls','toolDefinitions')
        AND (jsonb_typeof(part.value) <> 'number' OR part.value::text !~ '^(0|[1-9][0-9]*)$'))
    OR (p_breakdown->>'instructions')::bigint + (p_breakdown->>'skills')::bigint
       + (p_breakdown->>'messages')::bigint + (p_breakdown->>'toolCalls')::bigint
       + (p_breakdown->>'toolDefinitions')::bigint
       IS DISTINCT FROM (p_breakdown->>'estimatedInputTokens')::bigint
    OR (p_source = 'estimate' AND (p_breakdown->>'estimatedInputTokens')::bigint <> p_used_tokens)
  THEN
    RAISE EXCEPTION 'Invalid context breakdown' USING ERRCODE = '22023';
  END IF;
  UPDATE public.instance_context_state SET input_breakdown = p_breakdown
  WHERE instance_id = p_instance_id AND site_id = p_site_id
    AND model = p_model AND used_tokens = p_used_tokens
    AND source = p_source AND measured_at = p_measured_at
    AND EXISTS (SELECT 1 FROM public.remote_instances
      WHERE id = p_instance_id AND site_id = p_site_id);
END $$;

REVOKE ALL ON FUNCTION public.record_instance_context_breakdown(uuid,uuid,text,integer,text,timestamptz,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_instance_context_breakdown(uuid,uuid,text,integer,text,timestamptz,jsonb)
  TO service_role;

COMMIT;