-- Target: Apps Supabase. Protect automatic repair against aliases of applied SQL.
-- Deploy before the API repair path. Missing RPC fails closed (no file edits).
-- Supabase's non-superuser installer requires CREATE for ownership transfer.
GRANT USAGE, CREATE ON SCHEMA public TO apps_migration_coordinator;

CREATE OR REPLACE FUNCTION public.apps_check_pending_migration_repair(
  p_target_schema text,
  p_expected_tenant_id uuid,
  p_migration_key text,
  p_migration_checksum text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  already_applied boolean;
BEGIN
  IF p_target_schema !~ '^app_[a-f0-9]{24}$'
    OR p_migration_key !~ '^migration:[A-Za-z0-9_./-]+\.sql$'
    OR p_migration_checksum !~ '^[a-f0-9]{64}$'
    OR p_target_schema IS NULL OR p_migration_key IS NULL OR p_migration_checksum IS NULL
  THEN
    RAISE EXCEPTION 'Invalid pending migration repair lookup';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.apps_tenants
    WHERE tenant_id = p_expected_tenant_id AND schema = p_target_schema AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Tenant and schema do not match an active tenant';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_target_schema, 0));
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I._meta
      WHERE key = $1 OR (key LIKE ''migration:%%'' AND value->>''checksum'' = $2))',
    p_target_schema
  ) INTO already_applied USING p_migration_key, p_migration_checksum;
  RETURN jsonb_build_object('repairable', NOT already_applied);
END;
$function$;

REVOKE ALL ON FUNCTION public.apps_check_pending_migration_repair(text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apps_check_pending_migration_repair(text, uuid, text, text)
  TO service_role;
ALTER FUNCTION public.apps_check_pending_migration_repair(text, uuid, text, text)
  OWNER TO apps_migration_coordinator;
REVOKE CREATE ON SCHEMA public FROM apps_migration_coordinator;

-- Rollback: disable API automatic repair first, then drop this function.