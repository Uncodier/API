-- Scalar snapshots preserve all grouped history rows within one RPC result.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.get_system_status_daily_snapshot(p_since timestamptz, p_until timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.day, d.system_key), '[]'::jsonb)
  FROM public.get_system_status_daily(p_since, p_until) AS d;
$$;

CREATE OR REPLACE FUNCTION public.get_system_status_observed_sla_snapshot(p_since timestamptz, p_until timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) ORDER BY s.system_key), '[]'::jsonb)
  FROM public.get_system_status_observed_sla(p_since, p_until) AS s;
$$;

REVOKE ALL ON FUNCTION public.get_system_status_daily_snapshot(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_system_status_observed_sla_snapshot(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_system_status_daily_snapshot(timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_system_status_observed_sla_snapshot(timestamptz, timestamptz) TO service_role;

COMMIT;
