-- Optional compact read paths. Historical rows are never rewritten.
-- Rollback: drop the two RPCs, then public.status_observed_state(text, jsonb).
BEGIN;

-- Keep this precedence synchronized with src/lib/status/observation.ts.
CREATE OR REPLACE FUNCTION public.status_observed_state(status text, checks jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  evidence jsonb := COALESCE(checks, '{}'::jsonb);
  http_value jsonb;
  route_array jsonb;
  route jsonb;
  providers jsonb;
  provider jsonb;
  configured_count integer := 0;
  all_configuration boolean := true;
BEGIN
  IF status = 'down' THEN RETURN 'down'; END IF;
  IF status IS NULL OR status NOT IN ('up', 'degraded', 'skipped') THEN RETURN 'skipped'; END IF;
  IF status = 'skipped' THEN RETURN 'skipped'; END IF;

  FOR http_value IN SELECT value FROM pg_catalog.jsonb_array_elements(
    pg_catalog.jsonb_build_array(evidence -> 'httpStatus', evidence -> 'continuationHttpStatus'))
  LOOP
    IF pg_catalog.jsonb_typeof(http_value) = 'number' AND
      ((http_value::text)::numeric = 0 OR (http_value::text)::numeric >= 500 OR
       (http_value::text)::numeric IN (401, 403, 404, 429)) THEN RETURN 'down'; END IF;
  END LOOP;
  FOR route_array IN SELECT value FROM pg_catalog.jsonb_array_elements(
    pg_catalog.jsonb_build_array(evidence -> 'routes', evidence -> 'sampleRoutes'))
  LOOP
    IF pg_catalog.jsonb_typeof(route_array) = 'array' THEN
      FOR route IN SELECT value FROM pg_catalog.jsonb_array_elements(route_array)
      LOOP
        http_value := route -> 'status';
        IF pg_catalog.jsonb_typeof(http_value) = 'number' AND
          ((http_value::text)::numeric = 0 OR (http_value::text)::numeric >= 500 OR
           (http_value::text)::numeric IN (401, 403, 404, 429)) THEN RETURN 'down'; END IF;
      END LOOP;
    END IF;
  END LOOP;

  IF evidence -> 'verification' IN ('"unverified"'::jsonb, '"configuration"'::jsonb)
    OR evidence -> 'telemetryFound' = 'false'::jsonb THEN RETURN 'skipped'; END IF;
  IF evidence -> 'verification' = '"partial"'::jsonb
    AND evidence -> 'observedFailure' = 'false'::jsonb THEN RETURN 'skipped'; END IF;
  IF evidence -> 'routesRegistered' = 'true'::jsonb
    AND evidence -> 'sideEffectSafe' = 'true'::jsonb THEN RETURN 'skipped'; END IF;

  providers := COALESCE(NULLIF(evidence -> 'providers', 'null'::jsonb), evidence -> 'inheritedProviders');
  IF pg_catalog.jsonb_typeof(providers) IN ('object', 'array') THEN
    FOR provider IN
      SELECT value FROM pg_catalog.jsonb_each(
        CASE WHEN pg_catalog.jsonb_typeof(providers) = 'object' THEN providers ELSE '{}'::jsonb END)
      UNION ALL
      SELECT value FROM pg_catalog.jsonb_array_elements(
        CASE WHEN pg_catalog.jsonb_typeof(providers) = 'array' THEN providers ELSE '[]'::jsonb END)
    LOOP
      IF pg_catalog.jsonb_typeof(provider) = 'object' AND provider -> 'configured' = 'true'::jsonb THEN
        configured_count := configured_count + 1;
        all_configuration := all_configuration AND COALESCE(
          provider -> 'verification' = '"configuration"'::jsonb AND provider -> 'liveProbe' = 'false'::jsonb, false);
      END IF;
    END LOOP;
    IF configured_count > 0 AND all_configuration THEN RETURN 'skipped'; END IF;
  END IF;
  RETURN status;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_system_status_daily(p_since timestamptz, p_until timestamptz)
RETURNS TABLE (
  system_key text, day date, check_count bigint, observed_check_count bigint,
  up_check_count bigint, degraded_check_count bigint, down_check_count bigint, skipped_check_count bigint
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
  WITH observations AS MATERIALIZED (
    SELECT s.system_key, (s.created_at AT TIME ZONE 'UTC')::date AS day,
      public.status_observed_state(s.status, s.health_payload -> 'checks') AS state
    FROM public.system_status AS s
    WHERE s.created_at >= GREATEST(p_since, p_until - INTERVAL '2160 hours') AND s.created_at <= p_until
  )
  SELECT o.system_key, o.day, COUNT(*), COUNT(*) FILTER (WHERE o.state <> 'skipped'),
    COUNT(*) FILTER (WHERE o.state = 'up'), COUNT(*) FILTER (WHERE o.state = 'degraded'),
    COUNT(*) FILTER (WHERE o.state = 'down'), COUNT(*) FILTER (WHERE o.state = 'skipped')
  FROM observations AS o
  GROUP BY o.day, o.system_key
  ORDER BY o.day, o.system_key;
$$;

CREATE OR REPLACE FUNCTION public.get_system_status_observed_sla(p_since timestamptz, p_until timestamptz)
RETURNS TABLE (
  system_key text, total_24h bigint, up_24h bigint, total_7d bigint, up_7d bigint, total_30d bigint, up_30d bigint
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
  WITH observations AS MATERIALIZED (
    SELECT s.system_key, s.created_at,
      public.status_observed_state(s.status, s.health_payload -> 'checks') AS state
    FROM public.system_status AS s
    WHERE s.created_at >= GREATEST(p_since, p_until - INTERVAL '720 hours') AND s.created_at <= p_until
  )
  SELECT o.system_key,
    COUNT(*) FILTER (WHERE o.created_at >= p_until - INTERVAL '24 hours' AND o.state <> 'skipped'),
    COUNT(*) FILTER (WHERE o.created_at >= p_until - INTERVAL '24 hours' AND o.state = 'up'),
    COUNT(*) FILTER (WHERE o.created_at >= p_until - INTERVAL '168 hours' AND o.state <> 'skipped'),
    COUNT(*) FILTER (WHERE o.created_at >= p_until - INTERVAL '168 hours' AND o.state = 'up'),
    COUNT(*) FILTER (WHERE o.state <> 'skipped'), COUNT(*) FILTER (WHERE o.state = 'up')
  FROM observations AS o
  GROUP BY o.system_key
  ORDER BY o.system_key;
$$;

REVOKE ALL ON FUNCTION public.status_observed_state(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_system_status_daily(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_system_status_observed_sla(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.status_observed_state(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_system_status_daily(timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_system_status_observed_sla(timestamptz, timestamptz) TO service_role;

COMMIT;