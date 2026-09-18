-- Rollback:
-- DROP FUNCTION IF EXISTS public.release_deployment_recovery_scan_lease(text, text);
-- DROP FUNCTION IF EXISTS public.acquire_deployment_recovery_scan_lease(text, text, integer);
-- DROP TABLE IF EXISTS public.deployment_recovery_scan_leases;

CREATE TABLE IF NOT EXISTS public.deployment_recovery_scan_leases (
  lease_key text PRIMARY KEY,
  owner_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CHECK (char_length(lease_key) BETWEEN 1 AND 100),
  CHECK (char_length(owner_id) BETWEEN 1 AND 200)
);

ALTER TABLE public.deployment_recovery_scan_leases
  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deployment_recovery_scan_leases_service_role
  ON public.deployment_recovery_scan_leases;
CREATE POLICY deployment_recovery_scan_leases_service_role
  ON public.deployment_recovery_scan_leases
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.deployment_recovery_scan_leases
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.deployment_recovery_scan_leases TO service_role;

CREATE OR REPLACE FUNCTION public.acquire_deployment_recovery_scan_lease(
  p_lease_key text,
  p_owner_id text,
  p_ttl_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acquired boolean := false;
BEGIN
  IF NULLIF(btrim(p_lease_key), '') IS NULL
    OR NULLIF(btrim(p_owner_id), '') IS NULL
  THEN
    RAISE EXCEPTION 'Lease key and owner are required';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'Lease TTL must be between 1 and 3600 seconds';
  END IF;

  INSERT INTO public.deployment_recovery_scan_leases (
    lease_key,
    owner_id,
    expires_at,
    updated_at
  )
  VALUES (
    p_lease_key,
    p_owner_id,
    timezone('utc', now()) + make_interval(secs => p_ttl_seconds),
    timezone('utc', now())
  )
  ON CONFLICT (lease_key) DO UPDATE
  SET
    owner_id = EXCLUDED.owner_id,
    expires_at = EXCLUDED.expires_at,
    updated_at = EXCLUDED.updated_at
  WHERE deployment_recovery_scan_leases.expires_at <= timezone('utc', now())
    OR deployment_recovery_scan_leases.owner_id = EXCLUDED.owner_id
  RETURNING true INTO v_acquired;

  RETURN COALESCE(v_acquired, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_deployment_recovery_scan_lease(
  p_lease_key text,
  p_owner_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_released boolean := false;
BEGIN
  DELETE FROM public.deployment_recovery_scan_leases
  WHERE lease_key = p_lease_key
    AND owner_id = p_owner_id
  RETURNING true INTO v_released;
  RETURN COALESCE(v_released, false);
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_deployment_recovery_scan_lease(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_deployment_recovery_scan_lease(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_deployment_recovery_scan_lease(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_deployment_recovery_scan_lease(text, text) TO service_role;
