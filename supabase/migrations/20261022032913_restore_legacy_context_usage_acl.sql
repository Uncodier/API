-- Target: Makinari. Restore the declared service-only ACL of the legacy metrics overload.
-- No function body, tenant scope, table privilege or existing metrics are changed.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10s';
SET LOCAL search_path=pg_catalog;
DO $preflight$
DECLARE observed record;
BEGIN
  SELECT * INTO observed FROM pg_proc WHERE oid='public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,integer,text,timestamp with time zone)'::regprocedure;
  IF current_user<>'postgres' OR observed.proowner<>'postgres'::regrole
    OR observed.prosecdef OR observed.provolatile<>'v' OR observed.proisstrict
    OR observed.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
    OR md5(observed.prosrc)<>'0a78194c85f6ac07e965394a620fd4a3' THEN
    RAISE EXCEPTION 'Legacy context usage contract changed since audit';
  END IF;
END;
$preflight$;
REVOKE ALL ON FUNCTION public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,integer,text,timestamp with time zone) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,integer,text,timestamp with time zone) TO service_role;
DO $postflight$
BEGIN
  IF has_function_privilege('anon','public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,integer,text,timestamp with time zone)','EXECUTE')
    OR has_function_privilege('authenticated','public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,integer,text,timestamp with time zone)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,integer,text,timestamp with time zone)','EXECUTE') THEN
    RAISE EXCEPTION 'Legacy context usage execution boundary failed';
  END IF;
END;
$postflight$;
COMMIT;
