-- Unknown streamed output is NULL, not zero. Legacy RPC writers do not know
-- the output reserve of their effective model: invalidate any previous reserve
-- rather than reusing one from a different model during a rolling deploy.
BEGIN;

ALTER TABLE public.instance_context_state
  ALTER COLUMN output_tokens DROP NOT NULL,
  ALTER COLUMN output_tokens DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.record_instance_context_usage(
  p_instance_id uuid, p_site_id uuid, p_model text, p_provider text,
  p_used_tokens integer, p_output_tokens integer, p_available_tokens integer,
  p_source text, p_measured_at timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.instance_context_state
    (instance_id, site_id, model, provider, used_tokens, output_tokens, available_tokens,
     reserved_output_tokens, source, measured_at)
  SELECT p_instance_id, p_site_id, p_model, p_provider, p_used_tokens, p_output_tokens,
    p_available_tokens, NULL, p_source, p_measured_at
  WHERE EXISTS (SELECT 1 FROM public.remote_instances WHERE id = p_instance_id AND site_id = p_site_id)
  ON CONFLICT (instance_id) DO UPDATE SET
    model = EXCLUDED.model, provider = EXCLUDED.provider, used_tokens = EXCLUDED.used_tokens,
    output_tokens = EXCLUDED.output_tokens, available_tokens = EXCLUDED.available_tokens,
    reserved_output_tokens = NULL, source = EXCLUDED.source,
    measured_at = EXCLUDED.measured_at, updated_at = now()
  WHERE instance_context_state.site_id = EXCLUDED.site_id
    AND (instance_context_state.measured_at IS NULL OR instance_context_state.measured_at <= EXCLUDED.measured_at);
END $$;

-- Pre-output-token deployments may still call the eight-argument signature.
-- Keep it available without claiming a known completion count or reserve.
CREATE OR REPLACE FUNCTION public.record_instance_context_usage(
  p_instance_id uuid, p_site_id uuid, p_model text, p_provider text,
  p_used_tokens integer, p_available_tokens integer,
  p_source text, p_measured_at timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.record_instance_context_usage(p_instance_id, p_site_id, p_model,
    p_provider, p_used_tokens, NULL::integer, p_available_tokens, p_source, p_measured_at);
END $$;

REVOKE ALL ON FUNCTION public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,text,timestamptz)
  TO service_role;

COMMIT;