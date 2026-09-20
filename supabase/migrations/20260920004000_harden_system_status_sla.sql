-- Rollback:
-- CREATE INDEX IF NOT EXISTS idx_system_status_system_created
--   ON public.system_status (system_key, created_at DESC);
-- GRANT EXECUTE ON FUNCTION public.get_system_status_sla(timestamptz)
--   TO anon, authenticated;
-- Replace the bounded WHERE clause below with:
--   WHERE status_rows.created_at >= p_since

DROP INDEX IF EXISTS public.idx_system_status_system_created;

CREATE OR REPLACE FUNCTION public.get_system_status_sla(
  p_since timestamptz
)
RETURNS TABLE (
  system_key text,
  total_24h bigint,
  up_24h bigint,
  total_7d bigint,
  up_7d bigint,
  total_30d bigint,
  up_30d bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    status_rows.system_key::text,
    COUNT(*) FILTER (
      WHERE status_rows.created_at >= NOW() - INTERVAL '24 hours'
        AND status_rows.status IN ('up', 'down', 'degraded')
    ) AS total_24h,
    COUNT(*) FILTER (
      WHERE status_rows.created_at >= NOW() - INTERVAL '24 hours'
        AND status_rows.status = 'up'
    ) AS up_24h,
    COUNT(*) FILTER (
      WHERE status_rows.created_at >= NOW() - INTERVAL '7 days'
        AND status_rows.status IN ('up', 'down', 'degraded')
    ) AS total_7d,
    COUNT(*) FILTER (
      WHERE status_rows.created_at >= NOW() - INTERVAL '7 days'
        AND status_rows.status = 'up'
    ) AS up_7d,
    COUNT(*) FILTER (
      WHERE status_rows.status IN ('up', 'down', 'degraded')
    ) AS total_30d,
    COUNT(*) FILTER (
      WHERE status_rows.status = 'up'
    ) AS up_30d
  FROM public.system_status AS status_rows
  WHERE status_rows.created_at >= GREATEST(
    COALESCE(p_since, NOW() - INTERVAL '30 days'),
    NOW() - INTERVAL '30 days'
  )
  GROUP BY status_rows.system_key;
$$;

REVOKE ALL ON FUNCTION public.get_system_status_sla(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_system_status_sla(timestamptz)
  TO service_role;
