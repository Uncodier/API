-- Exact read-time normalization shared by both status history snapshots.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Keep this precedence synchronized with src/lib/status/observation.ts.
CREATE OR REPLACE FUNCTION public.status_observed_state(status text, checks jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  field text;
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

  -- Named JSON fields are absent on scalar, array and null inputs.
  IF checks IS NULL OR pg_catalog.jsonb_typeof(checks) <> 'object' THEN RETURN status; END IF;

  -- No constructed JSON arrays or SQL iteration for the common no-route case.
  IF checks ?| ARRAY['httpStatus', 'continuationHttpStatus'] THEN
    FOREACH field IN ARRAY ARRAY['httpStatus', 'continuationHttpStatus'] LOOP
      http_value := checks -> field;
      IF pg_catalog.jsonb_typeof(http_value) = 'number' AND
        (http_value >= '500'::jsonb OR http_value IN ('0'::jsonb, '401'::jsonb, '403'::jsonb, '404'::jsonb, '429'::jsonb))
      THEN RETURN 'down'; END IF;
    END LOOP;
  END IF;
  IF checks ?| ARRAY['routes', 'sampleRoutes'] THEN
    FOREACH field IN ARRAY ARRAY['routes', 'sampleRoutes'] LOOP
      route_array := checks -> field;
      IF pg_catalog.jsonb_typeof(route_array) = 'array' THEN
        FOR route IN SELECT value FROM pg_catalog.jsonb_array_elements(route_array) LOOP
          http_value := route -> 'status';
          IF pg_catalog.jsonb_typeof(http_value) = 'number' AND
            (http_value >= '500'::jsonb OR http_value IN ('0'::jsonb, '401'::jsonb, '403'::jsonb, '404'::jsonb, '429'::jsonb))
          THEN RETURN 'down'; END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  IF checks -> 'verification' IN ('"unverified"'::jsonb, '"configuration"'::jsonb)
    OR checks -> 'telemetryFound' = 'false'::jsonb THEN RETURN 'skipped'; END IF;
  IF checks -> 'verification' = '"partial"'::jsonb
    AND checks -> 'observedFailure' = 'false'::jsonb THEN RETURN 'skipped'; END IF;
  IF checks -> 'routesRegistered' = 'true'::jsonb
    AND checks -> 'sideEffectSafe' = 'true'::jsonb THEN RETURN 'skipped'; END IF;

  providers := COALESCE(NULLIF(checks -> 'providers', 'null'::jsonb), checks -> 'inheritedProviders');
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

REVOKE ALL ON FUNCTION public.status_observed_state(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.status_observed_state(text, jsonb) TO service_role;
COMMIT;
