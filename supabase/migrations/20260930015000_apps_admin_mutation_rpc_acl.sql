-- Apps Supabase ONLY (faxxouxekfwxvexoitxv), NOT the main Makinari database.
-- Prerequisite for 20260930020000_apps_tenant_storage.sql; neither is applied yet.
-- Audited callers in the dashboard are server-side, authorize site managers and
-- use a service-role client. Preserve that path; remove direct browser access.
-- Do not roll back by restoring arbitrary administrative SQL to PUBLIC/anon/users.
-- No function definitions, ownership, memberships, tables or Storage policies change.
BEGIN;
SET LOCAL search_path = pg_catalog;

REVOKE EXECUTE ON FUNCTION
  public.exec_sql(text),
  public.insert_schema_table_row(text, text, jsonb),
  public.update_schema_table_row(text, text, text, text, jsonb),
  public.delete_schema_table_rows(text, text, text, jsonb)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.exec_sql(text),
  public.insert_schema_table_row(text, text, jsonb),
  public.update_schema_table_row(text, text, text, text, jsonb),
  public.delete_schema_table_rows(text, text, text, jsonb)
TO service_role;

-- Direct REVOKE cannot remove inherited grants or unreviewed overloads. Verify
-- effective access and roll back rather than report a partial security repair.
DO $verify_admin_rpc_acl$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
      AND p.proname IN ('exec_sql', 'execute_sql', 'insert_schema_table_row',
        'update_schema_table_row', 'delete_schema_table_row', 'delete_schema_table_rows')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'Administrative RPC access remains through an inherited grant or unreviewed signature; no ACL repair committed';
  END IF;
END;
$verify_admin_rpc_acl$;

NOTIFY pgrst, 'reload schema';
COMMIT;