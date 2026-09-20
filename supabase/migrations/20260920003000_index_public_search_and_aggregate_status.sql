-- Rollback:
-- DROP FUNCTION IF EXISTS public.get_system_status_sla(timestamptz);
-- DROP INDEX IF EXISTS public.system_status_system_created_idx;
-- DROP INDEX IF EXISTS public.content_public_search_idx;
-- ALTER TABLE public.content DROP COLUMN IF EXISTS public_search;

ALTER TABLE public.content
  ADD COLUMN IF NOT EXISTS public_search tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple'::regconfig,
      COALESCE(title, '')
        || ' ' || COALESCE(description, '')
        || ' ' || COALESCE(text, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS content_public_search_idx
  ON public.content USING GIN (public_search)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS system_status_system_created_idx
  ON public.system_status (system_key, created_at DESC)
  INCLUDE (status);

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
  WHERE status_rows.created_at >= p_since
  GROUP BY status_rows.system_key;
$$;

REVOKE ALL ON FUNCTION public.get_system_status_sla(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_system_status_sla(timestamptz) TO service_role;
