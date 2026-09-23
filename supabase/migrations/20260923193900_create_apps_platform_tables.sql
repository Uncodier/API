-- Rollback:
-- DROP FUNCTION IF EXISTS public.tenant_id_from_jwt();
-- DROP FUNCTION IF EXISTS public.apps_exec_sql(text);
-- DROP TABLE IF EXISTS public.tenant_users;
-- DROP TABLE IF EXISTS public.apps_tenants;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.apps_tenants (
  tenant_id uuid PRIMARY KEY,
  requirement_id uuid NOT NULL,
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  schema text NOT NULL,
  bucket text NOT NULL,
  auth_provider text NOT NULL DEFAULT 'supabase'
    CHECK (auth_provider IN ('supabase', 'auth0')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'destroyed')),
  requires_isolation boolean NOT NULL DEFAULT false,
  limits jsonb NOT NULL DEFAULT jsonb_build_object(
    'max_rows_per_table', 100000,
    'max_storage_mb', 500,
    'max_auth_users', 10000,
    'max_rpc_calls_per_day', 50000
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS apps_tenants_requirement_unique
  ON public.apps_tenants (requirement_id);
CREATE INDEX IF NOT EXISTS apps_tenants_site_idx
  ON public.apps_tenants (site_id);

ALTER TABLE public.apps_tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apps_tenants_service_only
  ON public.apps_tenants;
CREATE POLICY apps_tenants_service_only
  ON public.apps_tenants
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON TABLE public.apps_tenants FROM anon, authenticated;
GRANT ALL ON TABLE public.apps_tenants TO service_role;

CREATE TABLE IF NOT EXISTS public.tenant_users (
  tenant_id uuid NOT NULL
    REFERENCES public.apps_tenants(tenant_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

ALTER TABLE public.tenant_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_users_service_only
  ON public.tenant_users;
CREATE POLICY tenant_users_service_only
  ON public.tenant_users
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS tenant_users_self_read
  ON public.tenant_users;
CREATE POLICY tenant_users_self_read
  ON public.tenant_users
  FOR SELECT
  USING (auth.uid() = user_id);

REVOKE ALL ON TABLE public.tenant_users FROM anon, authenticated;
GRANT SELECT ON TABLE public.tenant_users TO authenticated;
GRANT ALL ON TABLE public.tenant_users TO service_role;

CREATE OR REPLACE FUNCTION public.apps_exec_sql(sql text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF sql IS NULL OR length(trim(sql)) = 0 THEN
    RAISE EXCEPTION 'apps_exec_sql: empty SQL';
  END IF;
  EXECUTE sql;
END;
$function$;

REVOKE ALL ON FUNCTION public.apps_exec_sql(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apps_exec_sql(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_id_from_jwt()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT nullif(
    current_setting('request.jwt.claims', true)::jsonb->>'tenant_id',
    ''
  )::uuid;
$function$;
