BEGIN;
SET LOCAL lock_timeout = '5s';

-- The location ACL is intentionally not readable by service_role. Let the existing
-- service-only boolean predicate inspect it as its owner. Never grant the table,
-- remove a restriction, or elevate an unknown replacement body or unexpected caller.
DO $guard$
DECLARE
  actor pg_catalog.pg_proc%ROWTYPE;
  service oid := 'service_role'::pg_catalog.regrole;
BEGIN
  SELECT * INTO STRICT actor FROM pg_catalog.pg_proc
  WHERE oid = 'public.connector_catalog_read_actor(uuid,uuid,uuid,uuid)'::pg_catalog.regprocedure;
  IF actor.prosecdef OR actor.prorettype <> 'boolean'::pg_catalog.regtype
    OR actor.prolang <> (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'sql')
    OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(actor.prosrc, 'UTF8')), 'hex')
       <> 'e887918946ff1212e18b5e9c1cb5f41b60b36ee98d43cafcc850d2941f39addf'
    OR NOT pg_catalog.has_table_privilege(actor.proowner, 'public.site_member_location_restrictions', 'SELECT')
    OR NOT pg_catalog.has_function_privilege(service, actor.oid, 'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(actor.proacl, pg_catalog.acldefault('f', actor.proowner))) a
               WHERE a.grantee NOT IN (actor.proowner, service) OR (a.grantee = service AND a.is_grantable))
    OR pg_catalog.has_function_privilege('anon', actor.oid, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', actor.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected connector catalog actor definition or grants; review before applying' USING ERRCODE = '55000';
  END IF;
END;
$guard$;

-- No change to the function body, owner, OID, signature or EXECUTE ACL. All application
-- objects in the reviewed predicate are schema-qualified; builtins resolve from pg_catalog.
ALTER FUNCTION public.connector_catalog_read_actor(uuid,uuid,uuid,uuid)
  SECURITY DEFINER SET search_path TO '';

COMMIT;