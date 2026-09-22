-- Rollback:
-- DROP FUNCTION IF EXISTS public.reserve_platform_quota(
--   uuid, text, text, integer, integer
-- );
-- DROP FUNCTION IF EXISTS public.checkpoint_platform_quota_usage(
--   uuid, text, text, integer
-- );

CREATE OR REPLACE FUNCTION public.checkpoint_platform_quota_usage(
  p_site_id uuid,
  p_capability text,
  p_period text,
  p_used integer
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.platform_quotas (
    site_id,
    capability,
    period,
    used,
    created_at,
    updated_at
  )
  VALUES (
    p_site_id,
    p_capability,
    p_period,
    GREATEST(p_used, 0),
    timezone('utc', now()),
    timezone('utc', now())
  )
  ON CONFLICT (site_id, capability, period)
  DO UPDATE SET
    used = GREATEST(public.platform_quotas.used, EXCLUDED.used),
    updated_at = timezone('utc', now());
$$;

REVOKE ALL ON FUNCTION public.checkpoint_platform_quota_usage(
  uuid,
  text,
  text,
  integer
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.checkpoint_platform_quota_usage(
  uuid,
  text,
  text,
  integer
) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_platform_quota(
  p_site_id uuid,
  p_capability text,
  p_period text,
  p_cost integer,
  p_default_limit integer
)
RETURNS TABLE(allowed boolean, used integer, quota_limit integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer;
BEGIN
  INSERT INTO public.platform_quotas (
    site_id,
    capability,
    period,
    used,
    created_at,
    updated_at
  )
  VALUES (
    p_site_id,
    p_capability,
    p_period,
    0,
    timezone('utc', now()),
    timezone('utc', now())
  )
  ON CONFLICT (site_id, capability, period) DO NOTHING;

  RETURN QUERY
  UPDATE public.platform_quotas AS quota
  SET
    used = quota.used + GREATEST(p_cost, 1),
    updated_at = timezone('utc', now())
  WHERE quota.site_id = p_site_id
    AND quota.capability = p_capability
    AND quota.period = p_period
    AND quota.used + GREATEST(p_cost, 1)
      <= COALESCE(quota.quota_override, p_default_limit)
  RETURNING
    true,
    quota.used,
    COALESCE(quota.quota_override, p_default_limit);

  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 0 THEN
    RETURN QUERY
    SELECT
      false,
      quota.used,
      COALESCE(quota.quota_override, p_default_limit)
    FROM public.platform_quotas AS quota
    WHERE quota.site_id = p_site_id
      AND quota.capability = p_capability
      AND quota.period = p_period;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_platform_quota(
  uuid,
  text,
  text,
  integer,
  integer
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_platform_quota(
  uuid,
  text,
  text,
  integer,
  integer
) TO service_role;
