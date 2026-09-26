-- Follow-up to 20260926000000_instance_context_memory.sql. Forward-only:
-- retain the output reserve used at measurement time so the UI matches the
-- model-specific budget even when its metadata is not available to the web app.
BEGIN;

ALTER TABLE public.instance_context_state
  ADD COLUMN IF NOT EXISTS reserved_output_tokens integer;

CREATE OR REPLACE FUNCTION public.record_instance_context_usage(
  p_instance_id uuid, p_site_id uuid, p_model text, p_provider text,
  p_used_tokens integer, p_output_tokens integer, p_available_tokens integer,
  p_reserved_output_tokens integer, p_source text, p_measured_at timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.instance_context_state
    (instance_id, site_id, model, provider, used_tokens, output_tokens,
     available_tokens, reserved_output_tokens, source, measured_at)
  SELECT p_instance_id, p_site_id, p_model, p_provider, p_used_tokens, p_output_tokens,
    p_available_tokens, p_reserved_output_tokens, p_source, p_measured_at
  WHERE EXISTS (SELECT 1 FROM public.remote_instances WHERE id = p_instance_id AND site_id = p_site_id)
  ON CONFLICT (instance_id) DO UPDATE SET
    model = EXCLUDED.model, provider = EXCLUDED.provider, used_tokens = EXCLUDED.used_tokens,
    output_tokens = EXCLUDED.output_tokens, available_tokens = EXCLUDED.available_tokens,
    reserved_output_tokens = EXCLUDED.reserved_output_tokens, source = EXCLUDED.source,
    measured_at = EXCLUDED.measured_at, updated_at = now()
  WHERE instance_context_state.site_id = EXCLUDED.site_id
    AND (instance_context_state.measured_at IS NULL OR instance_context_state.measured_at <= EXCLUDED.measured_at);
END $$;

REVOKE ALL ON FUNCTION public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,integer,integer,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,integer,integer,text,timestamptz)
  TO service_role;

-- Keep the old signature during a rolling deploy. It only writes legacy
-- measurements, while the new writer persists the exact model reserve.

COMMIT;