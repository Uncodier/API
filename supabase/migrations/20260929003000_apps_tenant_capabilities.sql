-- Apps Supabase ONLY. Forward-only platform capabilities, independent of the
-- unapplied auth-schema grant repair. No auth schema access or tenant ledger edits.
-- Apply after the isolated bootstrap / 20260926080000 provisioning migration.
-- PostgreSQL schema owners can DROP contained objects even when another role
-- owns them. Coordinator ownership prevents replacement/ALTER, not destructive
-- schema-owner DROP; the getter detects missing or substituted helpers and fails
-- closed. Do not change tenant schema ownership or rewrite tenant migrations.

BEGIN;

-- One private implementation keeps installer and read-only verification identical.
-- Only the two fixed-mode service-role RPCs below may call it.
CREATE FUNCTION public._apps_tenant_capabilities(
  p_requirement_id uuid,
  p_expected_tenant_id uuid,
  p_install boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  tenant_row public.apps_tenants%ROWTYPE;
  owner_role text;
  owner_oid oid;
  coordinator_oid oid := to_regrole('apps_migration_coordinator')::oid;
  namespace_oid oid;
  helper_names text[] := ARRAY[
    '_app_current_user_id', '_app_request_claims', '_app_is_backend_request'
  ];
  helper_types text[] := ARRAY['uuid', 'jsonb', 'boolean'];
  helper_bodies text[];
  helper record;
  missing_helpers integer[] := ARRAY[]::integer[];
  helper_index integer;
  verification_pass integer;
  actual_bucket text;
BEGIN
  IF p_requirement_id IS NULL OR p_expected_tenant_id IS NULL OR p_install IS NULL THEN
    RAISE EXCEPTION 'Invalid tenant capability request';
  END IF;

  IF p_install THEN
    -- Match apps_ensure_tenant, then apps_apply_migration's whole-schema stream.
    PERFORM pg_advisory_xact_lock(hashtextextended('tenant:' || p_requirement_id::text, 0));
  END IF;

  SELECT * INTO tenant_row
  FROM public.apps_tenants
  WHERE requirement_id = p_requirement_id
    AND tenant_id = p_expected_tenant_id;
  IF NOT FOUND OR tenant_row.status IS DISTINCT FROM 'active'
    OR tenant_row.schema IS NULL OR tenant_row.schema !~ '^app_[a-f0-9]{24}$'
    OR tenant_row.user_id IS NULL
  THEN
    RAISE EXCEPTION 'Tenant capability registry binding is not active and valid';
  END IF;

  IF p_install THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(tenant_row.schema, 0));
    -- Serialize registry changes without taking a row lock in the read-only RPC.
    PERFORM 1 FROM public.apps_tenants
    WHERE requirement_id = p_requirement_id AND tenant_id = p_expected_tenant_id
      AND schema = tenant_row.schema AND user_id = tenant_row.user_id AND status = 'active'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Tenant capability registry binding changed';
    END IF;
  END IF;

  owner_role := 'app_owner_' || substring(tenant_row.schema FROM 5);
  SELECT r.oid, n.oid INTO owner_oid, namespace_oid
  FROM pg_catalog.pg_namespace AS n
  JOIN pg_catalog.pg_roles AS r ON r.oid = n.nspowner
  WHERE n.nspname = tenant_row.schema AND r.rolname = owner_role
    AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
      OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid);
  IF owner_oid IS NULL OR coordinator_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles AS r WHERE r.oid = coordinator_oid
      AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
        OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid)
  ) THEN
    RAISE EXCEPTION 'Tenant capability owner roles are not isolated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE relnamespace = namespace_oid AND relname = '_meta'
      AND relkind = 'r' AND relrowsecurity AND relowner = coordinator_oid
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE pronamespace = namespace_oid AND proname = '_execute_tenant_migration'
      AND proargtypes = '25'::oidvector AND proowner = owner_oid AND prosecdef
  ) THEN
    RAISE EXCEPTION 'Tenant capabilities require a complete isolated bootstrap';
  END IF;

  -- auth.uid semantics: legacy sub takes precedence over claims.sub. Invalid
  -- JSON/UUID identity is NULL rather than an exception or an authorization grant.
  -- These are literal expected prosrc values, never comments/source metadata.
  helper_bodies := ARRAY[$identity$
BEGIN
  RETURN COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$identity$, $claims$
BEGIN
  RETURN COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')
  )::jsonb;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$claims$, format($backend$
DECLARE
  claims jsonb;
BEGIN
  claims := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')
  )::jsonb;
  RETURN COALESCE(
    claims ->> 'role' = 'authenticated'
    AND claims ->> 'tenant_id' = %L
    AND claims ->> 'schema' = %L
    AND claims ->> 'sub' = %L
    AND COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), claims ->> 'sub') = %L,
    false
  );
EXCEPTION WHEN invalid_text_representation THEN
  RETURN false;
END;
$backend$, tenant_row.tenant_id::text, tenant_row.schema,
    tenant_row.user_id::text, tenant_row.user_id::text)];

  -- Preflight ALL reserved names before installing any; then verify the result.
  -- Overloads/default arguments are conflicts too, not alternate capabilities.
  FOR verification_pass IN 1..2 LOOP
    FOR helper_index IN 1..3 LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc
        WHERE pronamespace = namespace_oid AND proname = helper_names[helper_index]
      ) THEN
        IF p_install AND verification_pass = 1 THEN
          missing_helpers := array_append(missing_helpers, helper_index);
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'Missing reserved tenant capability helper: %', helper_names[helper_index];
      END IF;

      IF (SELECT count(*) FROM pg_catalog.pg_proc
        WHERE pronamespace = namespace_oid AND proname = helper_names[helper_index]) <> 1
      THEN
        RAISE EXCEPTION 'Conflicting reserved tenant capability helper: %', helper_names[helper_index];
      END IF;
      SELECT p.*, l.lanname INTO helper
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
      WHERE p.pronamespace = namespace_oid AND p.proname = helper_names[helper_index];
      IF helper.proowner IS DISTINCT FROM coordinator_oid
        OR helper.prosrc IS DISTINCT FROM helper_bodies[helper_index]
        OR helper.lanname <> 'plpgsql' OR helper.prokind <> 'f'
        OR helper.pronargs <> 0 OR helper.pronargdefaults <> 0
        OR helper.proallargtypes IS NOT NULL OR helper.proargmodes IS NOT NULL
        OR helper.prorettype <> to_regtype(helper_types[helper_index])::oid
        OR helper.prosecdef OR helper.proretset OR helper.proisstrict OR helper.proleakproof
        OR helper.provolatile <> 's' OR helper.proparallel <> 'u'
        OR helper.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
        OR EXISTS (
          SELECT 1 FROM aclexplode(COALESCE(helper.proacl, acldefault('f', helper.proowner))) AS acl
          WHERE acl.grantee NOT IN (coordinator_oid, owner_oid,
            to_regrole('anon')::oid, to_regrole('authenticated')::oid)
            OR acl.is_grantable OR acl.privilege_type <> 'EXECUTE'
        )
        OR NOT has_function_privilege(owner_oid, helper.oid, 'EXECUTE')
        OR NOT has_function_privilege('anon', helper.oid, 'EXECUTE')
        OR NOT has_function_privilege('authenticated', helper.oid, 'EXECUTE')
      THEN
        RAISE EXCEPTION 'Conflicting reserved tenant capability helper: %', helper_names[helper_index];
      END IF;
    END LOOP;

    IF verification_pass = 1 AND cardinality(missing_helpers) > 0 THEN
      -- The existing postgres provisioner can SET (but does not inherit) the
      -- coordinator role. New owner needs CREATE only for ownership transfer.
      EXECUTE format('GRANT CREATE ON SCHEMA %I TO apps_migration_coordinator', tenant_row.schema);
      FOREACH helper_index IN ARRAY missing_helpers LOOP
        EXECUTE format(
          'CREATE FUNCTION %I.%I() RETURNS %s LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS %L',
          tenant_row.schema, helper_names[helper_index], helper_types[helper_index], helper_bodies[helper_index]
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.%I() FROM PUBLIC, anon, authenticated, service_role, %I',
          tenant_row.schema, helper_names[helper_index], owner_role
        );
        EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I() TO anon, authenticated, %I',
          tenant_row.schema, helper_names[helper_index], owner_role);
        EXECUTE format('ALTER FUNCTION %I.%I() OWNER TO apps_migration_coordinator',
          tenant_row.schema, helper_names[helper_index]);
      END LOOP;
      EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM apps_migration_coordinator', tenant_row.schema);
    END IF;
  END LOOP;

  -- Registry bucket names are intentions, not proof that Storage is available.
  -- Dynamic SQL deliberately avoids a dependency on an optional storage schema.
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    EXECUTE 'SELECT id::text FROM storage.buckets WHERE id = $1'
      INTO actual_bucket USING tenant_row.bucket;
  END IF;

  RETURN jsonb_build_object(
    'version', 1,
    'requirement_id', tenant_row.requirement_id,
    'tenant_id', tenant_row.tenant_id,
    'schema', tenant_row.schema,
    'identity', jsonb_build_object(
      'user_id', tenant_row.schema || '._app_current_user_id',
      'claims', tenant_row.schema || '._app_request_claims',
      'backend', tenant_row.schema || '._app_is_backend_request'
    ),
    'storage', jsonb_build_object('bucket', actual_bucket, 'available', actual_bucket IS NOT NULL),
    'backend', jsonb_build_object('role', 'authenticated', 'bypasses_rls', false, 'operations', '[]'::jsonb)
  );
END;
$function$;

ALTER FUNCTION public._apps_tenant_capabilities(uuid, uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._apps_tenant_capabilities(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.apps_ensure_tenant_capabilities(p_requirement_id uuid, p_expected_tenant_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT public._apps_tenant_capabilities(p_requirement_id, p_expected_tenant_id, true);
$function$;
ALTER FUNCTION public.apps_ensure_tenant_capabilities(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apps_ensure_tenant_capabilities(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apps_ensure_tenant_capabilities(uuid, uuid) TO service_role;

CREATE FUNCTION public.apps_get_tenant_capabilities(p_requirement_id uuid, p_expected_tenant_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT public._apps_tenant_capabilities(p_requirement_id, p_expected_tenant_id, false);
$function$;
ALTER FUNCTION public.apps_get_tenant_capabilities(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apps_get_tenant_capabilities(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apps_get_tenant_capabilities(uuid, uuid) TO service_role;

DO $tenant_capability_backfill$
DECLARE
  tenant record;
BEGIN
  -- Migration-local registry RLS context only; never set claims in request helpers.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  FOR tenant IN
    SELECT requirement_id, tenant_id FROM public.apps_tenants
    WHERE status = 'active' ORDER BY requirement_id
  LOOP
    PERFORM public.apps_ensure_tenant_capabilities(tenant.requirement_id, tenant.tenant_id);
  END LOOP;
END;
$tenant_capability_backfill$;

COMMIT;