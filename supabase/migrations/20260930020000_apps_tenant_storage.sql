-- Apps Supabase ONLY. Platform Storage authorization; not a tenant migration.
-- No bucket/object metadata writes, membership backfill, auth-schema grants or
-- role elevation. Buckets are created/verified separately through the Storage API.
-- The installer must ALREADY be allowed to manage storage.objects policies.
-- In particular, postgres may not own Supabase's supabase_storage_admin table:
-- insufficient authority aborts this entire transaction; do not acquire it here.
BEGIN;
SET LOCAL search_path = pg_catalog;

DO $install_storage$
DECLARE
  helper_body text := $helper$
DECLARE
  claims jsonb;
  subject text;
  tenant_row public.apps_tenants%ROWTYPE;
  segments text[];
BEGIN
  -- Only the server-verified request claims GUC is authoritative. Never read
  -- user_metadata/app_metadata, HTTP headers, or caller-supplied identity args.
  claims := NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  IF jsonb_typeof(claims) IS DISTINCT FROM 'object'
    OR claims ->> 'role' IS DISTINCT FROM 'authenticated'
    OR jsonb_typeof(claims -> 'sub') IS DISTINCT FROM 'string'
  THEN
    RETURN false;
  END IF;
  subject := claims ->> 'sub';
  IF subject !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR p_owner_id IS DISTINCT FROM subject
    OR p_bucket IS NULL OR p_bucket !~ '^tenant-[a-f0-9]{24}$'
    OR p_name IS NULL OR btrim(p_name) = ''
    OR strpos(p_name, chr(92)) > 0
  THEN
    RETURN false;
  END IF;
  segments := string_to_array(p_name, '/');
  IF EXISTS (SELECT 1 FROM unnest(segments) AS segment
    WHERE btrim(segment) = '' OR segment IN ('.', '..'))
  THEN
    RETURN false;
  END IF;

  -- Include inactive rows in the ambiguity check: a duplicate bucket must never
  -- silently change the authority for existing objects when its status changes.
  IF (SELECT count(*) FROM public.apps_tenants WHERE bucket = p_bucket) <> 1 THEN
    RETURN false;
  END IF;
  SELECT * INTO tenant_row FROM public.apps_tenants WHERE bucket = p_bucket;
  IF NOT FOUND OR tenant_row.status IS DISTINCT FROM 'active'
    OR tenant_row.schema IS NULL OR tenant_row.schema !~ '^app_[a-f0-9]{24}$'
    OR tenant_row.bucket IS DISTINCT FROM 'tenant-' || substring(tenant_row.schema FROM 5)
    OR tenant_row.tenant_id IS NULL OR tenant_row.user_id IS NULL
    OR tenant_row.requirement_id IS NULL OR tenant_row.site_id IS NULL
  THEN
    RETURN false;
  END IF;

  -- A registry-owner subject carrying EITHER scoped claim is backend-scoped.
  -- Require BOTH exact claims and never fall through to personal user storage,
  -- even if this subject also has a tenant_users membership. An ordinary user
  -- JWT without scoped claims may use its own membership, including the owner.
  IF subject = tenant_row.user_id::text AND (claims ? 'tenant_id' OR claims ? 'schema') THEN
    RETURN COALESCE(
      claims ->> 'tenant_id' = tenant_row.tenant_id::text
      AND claims ->> 'schema' = tenant_row.schema
      AND segments[1] = 'backend' AND cardinality(segments) >= 2,
      false
    );
  END IF;

  -- Personal user files are not app/org-shared. Optional scoped claims constrain
  -- membership; neither metadata nor being the registry owner grants membership.
  IF (claims ? 'tenant_id' AND claims ->> 'tenant_id' IS DISTINCT FROM tenant_row.tenant_id::text)
    OR (claims ? 'schema' AND claims ->> 'schema' IS DISTINCT FROM tenant_row.schema)
    OR segments[1] IS DISTINCT FROM 'users' OR segments[2] IS DISTINCT FROM subject
    OR cardinality(segments) < 3
  THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.tenant_users
    WHERE tenant_id = tenant_row.tenant_id AND user_id = subject::uuid
      AND role IN ('member', 'editor', 'admin', 'owner')
  );
EXCEPTION WHEN OTHERS THEN
  -- Malformed claims, missing registry dependencies or inaccessible data fail
  -- closed without exposing registry contents or parser errors to Storage users.
  RETURN false;
END;
$helper$;
  getter_body text;
BEGIN
  -- Legacy arbitrary-SQL/table-mutation definers would let browser callers forge
  -- the registry or membership authority. Refuse installation on that unsafe
  -- platform; repairing unrelated RPC grants requires a separate operator change.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
      AND p.proname IN ('exec_sql', 'execute_sql', 'insert_schema_table_row',
        'update_schema_table_row', 'delete_schema_table_row', 'delete_schema_table_rows')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE')))
  THEN
    RAISE EXCEPTION 'Apps Storage requires operator repair of unsafe public mutation RPC privileges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
    WHERE oid = to_regclass('storage.objects') AND relkind = 'r' AND relrowsecurity)
  THEN
    RAISE EXCEPTION 'Apps Storage requires an existing RLS-enabled storage.objects table';
  END IF;
  IF current_user IN ('anon', 'authenticated', 'service_role')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname IN ('anon', 'authenticated') AND (rolsuper OR rolbypassrls))
    OR pg_has_role('anon', current_user, 'MEMBER')
    OR pg_has_role('authenticated', current_user, 'MEMBER')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
      WHERE c.oid IN ('storage.objects'::regclass, 'public.apps_tenants'::regclass,
        'public.tenant_users'::regclass)
        AND (pg_has_role('anon', c.relowner, 'MEMBER')
          OR pg_has_role('authenticated', c.relowner, 'MEMBER')))
  THEN
    RAISE EXCEPTION 'Apps Storage authorization roles are not isolated';
  END IF;
  -- Permissive policies combine with OR. Preserve the existing, narrowly scoped
  -- service-only workspaces policy, but do not certify other permissive policies
  -- which could bypass tenant authorization. Unknown policies require review, not
  -- deletion or modification by this platform migration.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS p
    WHERE p.polrelid = 'storage.objects'::regclass AND p.polpermissive
      AND p.polname NOT IN ('apps_tenant_storage_select', 'apps_tenant_storage_insert',
        'apps_tenant_storage_update', 'apps_tenant_storage_delete')
      AND NOT (p.polname = 'workspaces service only' AND p.polcmd = '*'
        AND p.polroles = ARRAY[0::oid]
        AND pg_get_expr(p.polqual, p.polrelid) IS NOT DISTINCT FROM
          '((bucket_id = ''workspaces''::text) AND (auth.role() = ''service_role''::text))'
        AND pg_get_expr(p.polwithcheck, p.polrelid) IS NOT DISTINCT FROM
          '((bucket_id = ''workspaces''::text) AND (auth.role() = ''service_role''::text))'))
  THEN
    RAISE EXCEPTION 'Apps Storage requires operator review of unrelated permissive Storage policies';
  END IF;
  -- Reserved overloads could divert policy/RPC resolution. Do not adopt them.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('apps_storage_object_allowed', 'apps_get_tenant_storage_config')
      AND (proowner <> current_user::regrole::oid
        OR (proname = 'apps_storage_object_allowed' AND proargtypes <> '25 25 25'::oidvector)
        OR (proname = 'apps_get_tenant_storage_config' AND proargtypes <> '2950 2950'::oidvector)))
  THEN
    RAISE EXCEPTION 'Conflicting reserved Apps Storage function';
  END IF;

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION public.apps_storage_object_allowed(p_bucket text, p_name text, p_owner_id text)
    RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS %L
  $ddl$, helper_body);
  REVOKE ALL ON FUNCTION public.apps_storage_object_allowed(text, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.apps_storage_object_allowed(text, text, text) TO authenticated;

  -- Touch only these four platform-owned policy names. Keep all unrelated
  -- workspace policies and Storage table privileges/ownership unchanged.
  DROP POLICY IF EXISTS apps_tenant_storage_select ON storage.objects;
  CREATE POLICY apps_tenant_storage_select ON storage.objects
    FOR SELECT TO authenticated
    USING (public.apps_storage_object_allowed(bucket_id, name, owner_id));
  DROP POLICY IF EXISTS apps_tenant_storage_insert ON storage.objects;
  CREATE POLICY apps_tenant_storage_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (public.apps_storage_object_allowed(bucket_id, name, owner_id));
  DROP POLICY IF EXISTS apps_tenant_storage_update ON storage.objects;
  CREATE POLICY apps_tenant_storage_update ON storage.objects
    FOR UPDATE TO authenticated
    USING (public.apps_storage_object_allowed(bucket_id, name, owner_id))
    WITH CHECK (public.apps_storage_object_allowed(bucket_id, name, owner_id));
  DROP POLICY IF EXISTS apps_tenant_storage_delete ON storage.objects;
  CREATE POLICY apps_tenant_storage_delete ON storage.objects
    FOR DELETE TO authenticated
    USING (public.apps_storage_object_allowed(bucket_id, name, owner_id));

  -- Embed the expected implementation, not a hash/comment supplied by a mutable
  -- helper. The read-only service RPC verifies live catalogs before returning the
  -- provisioning contract. Capture the installer identity without changing roles.
  getter_body := format($getter$
DECLARE
  tenant_row public.apps_tenants%%ROWTYPE;
  helper record;
  policy record;
  expected_owner oid := to_regrole(%L)::oid;
  authenticated_oid oid := to_regrole('authenticated')::oid;
  service_oid oid := to_regrole('service_role')::oid;
  objects_oid oid := to_regclass('storage.objects')::oid;
  expected_expression text := 'public.apps_storage_object_allowed(bucket_id, name, owner_id)';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
      AND p.proname IN ('exec_sql', 'execute_sql', 'insert_schema_table_row',
        'update_schema_table_row', 'delete_schema_table_row', 'delete_schema_table_rows')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE')))
  THEN
    RAISE EXCEPTION 'Apps Storage requires operator repair of unsafe public mutation RPC privileges';
  END IF;
  IF p_requirement_id IS NULL OR p_expected_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Apps Storage configuration request';
  END IF;
  IF (SELECT count(*) FROM public.apps_tenants
    WHERE requirement_id = p_requirement_id OR tenant_id = p_expected_tenant_id) <> 1
  THEN
    RAISE EXCEPTION 'Apps Storage registry binding is not active and valid';
  END IF;
  SELECT * INTO tenant_row FROM public.apps_tenants
  WHERE requirement_id = p_requirement_id AND tenant_id = p_expected_tenant_id;
  IF NOT FOUND OR tenant_row.status IS DISTINCT FROM 'active'
    OR tenant_row.schema IS NULL OR tenant_row.schema !~ '^app_[a-f0-9]{24}$'
    OR tenant_row.bucket IS NULL OR tenant_row.bucket !~ '^tenant-[a-f0-9]{24}$'
    OR tenant_row.bucket IS DISTINCT FROM 'tenant-' || substring(tenant_row.schema FROM 5)
    OR tenant_row.user_id IS NULL OR tenant_row.site_id IS NULL
    OR (SELECT count(*) FROM public.apps_tenants WHERE bucket = tenant_row.bucket) <> 1
  THEN
    RAISE EXCEPTION 'Apps Storage registry binding is not active and valid';
  END IF;

  IF expected_owner IS NULL OR authenticated_oid IS NULL OR service_oid IS NULL
    OR expected_owner IN (authenticated_oid, service_oid, to_regrole('anon')::oid)
    OR pg_has_role('authenticated', expected_owner, 'MEMBER')
    OR pg_has_role('anon', expected_owner, 'MEMBER')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname IN ('anon', 'authenticated') AND (rolsuper OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
      WHERE c.oid IN (objects_oid, 'public.apps_tenants'::regclass, 'public.tenant_users'::regclass)
        AND (pg_has_role('anon', c.relowner, 'MEMBER')
          OR pg_has_role('authenticated', c.relowner, 'MEMBER')))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
      WHERE oid = objects_oid AND relkind = 'r' AND relrowsecurity)
    OR (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'apps_storage_object_allowed') <> 1
  THEN
    RAISE EXCEPTION 'Apps Storage authorization protections are missing or changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS p
    WHERE p.polrelid = objects_oid AND p.polpermissive
      AND p.polname NOT IN ('apps_tenant_storage_select', 'apps_tenant_storage_insert',
        'apps_tenant_storage_update', 'apps_tenant_storage_delete')
      AND NOT (p.polname = 'workspaces service only' AND p.polcmd = '*'
        AND p.polroles = ARRAY[0::oid]
        AND pg_get_expr(p.polqual, p.polrelid) IS NOT DISTINCT FROM
          '((bucket_id = ''workspaces''::text) AND (auth.role() = ''service_role''::text))'
        AND pg_get_expr(p.polwithcheck, p.polrelid) IS NOT DISTINCT FROM
          '((bucket_id = ''workspaces''::text) AND (auth.role() = ''service_role''::text))'))
  THEN
    RAISE EXCEPTION 'Apps Storage requires operator review of unrelated permissive Storage policies';
  END IF;
  SELECT p.*, l.lanname INTO helper FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
  WHERE p.oid = to_regprocedure('public.apps_storage_object_allowed(text,text,text)');
  IF NOT FOUND OR helper.proowner IS DISTINCT FROM expected_owner
    OR helper.prosrc IS DISTINCT FROM %L
    OR helper.lanname <> 'plpgsql' OR helper.prokind <> 'f'
    OR helper.proargtypes <> '25 25 25'::oidvector OR helper.pronargs <> 3
    OR helper.pronargdefaults <> 0 OR helper.proallargtypes IS NOT NULL OR helper.proargmodes IS NOT NULL
    OR helper.prorettype <> 'boolean'::regtype OR NOT helper.prosecdef
    OR helper.proretset OR helper.proisstrict OR helper.proleakproof
    OR helper.provolatile <> 's' OR helper.proparallel <> 'u'
    OR helper.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
    OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(helper.proacl, acldefault('f', helper.proowner))) AS acl
      WHERE acl.grantee NOT IN (expected_owner, authenticated_oid)
        OR acl.is_grantable OR acl.privilege_type <> 'EXECUTE')
    OR NOT has_function_privilege('authenticated', helper.oid, 'EXECUTE')
    OR has_function_privilege('anon', helper.oid, 'EXECUTE')
    OR has_function_privilege('service_role', helper.oid, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Apps Storage authorization protections are missing or changed';
  END IF;

  FOR policy IN SELECT * FROM (VALUES
    ('apps_tenant_storage_select', 'r', true, false),
    ('apps_tenant_storage_insert', 'a', false, true),
    ('apps_tenant_storage_update', 'w', true, true),
    ('apps_tenant_storage_delete', 'd', true, false)
  ) AS expected(name, command, has_using, has_check)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS p
      WHERE p.polrelid = objects_oid AND p.polname = policy.name
        AND p.polcmd::text = policy.command AND p.polpermissive
        AND p.polroles = ARRAY[authenticated_oid]::oid[]
        AND pg_get_expr(p.polqual, p.polrelid) IS NOT DISTINCT FROM
          CASE WHEN policy.has_using THEN expected_expression END
        AND pg_get_expr(p.polwithcheck, p.polrelid) IS NOT DISTINCT FROM
          CASE WHEN policy.has_check THEN expected_expression END)
    THEN
      RAISE EXCEPTION 'Apps Storage authorization protections are missing or changed';
    END IF;
  END LOOP;

  -- Check the operator boundary as well; no public/authenticated config access.
  SELECT p.* INTO helper FROM pg_catalog.pg_proc AS p
  WHERE p.oid = to_regprocedure('public.apps_get_tenant_storage_config(uuid,uuid)');
  IF (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'apps_get_tenant_storage_config') <> 1
    OR helper.proowner IS DISTINCT FROM expected_owner OR NOT helper.prosecdef
    OR helper.provolatile <> 's'
    OR helper.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
    OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(helper.proacl, acldefault('f', helper.proowner))) AS acl
      WHERE acl.grantee NOT IN (expected_owner, service_oid)
        OR acl.is_grantable OR acl.privilege_type <> 'EXECUTE')
    OR NOT has_function_privilege('service_role', helper.oid, 'EXECUTE')
    OR has_function_privilege('authenticated', helper.oid, 'EXECUTE')
    OR has_function_privilege('anon', helper.oid, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Apps Storage authorization protections are missing or changed';
  END IF;

  -- max_storage_mb is a total tenant quota, NOT a per-object limit. Do not reuse it.
  -- Bucket existence/privacy/limits are verified by the caller via the Storage API.
  RETURN jsonb_build_object(
    'version', 1, 'requirement_id', tenant_row.requirement_id,
    'tenant_id', tenant_row.tenant_id, 'schema', tenant_row.schema,
    'bucket', tenant_row.bucket, 'user_id', tenant_row.user_id,
    'site_id', tenant_row.site_id, 'status', 'active', 'policy_version', 1,
    'file_size_limit', 10485760,
    'allowed_mime_types', jsonb_build_array(
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
      'text/plain', 'text/csv', 'application/json', 'application/octet-stream'
    )
  );
END;
$getter$, current_user, helper_body);
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION public.apps_get_tenant_storage_config(p_requirement_id uuid, p_expected_tenant_id uuid)
    RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS %L
  $ddl$, getter_body);
  REVOKE ALL ON FUNCTION public.apps_get_tenant_storage_config(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.apps_get_tenant_storage_config(uuid, uuid) TO service_role;
  -- CREATE OR REPLACE preserves old ACL entries, and default privileges can add
  -- unexpected grants on first install. Refuse those instead of silently leaving
  -- a broader EXECUTE surface or changing unrelated roles/default privileges.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p,
      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE p.oid IN ('public.apps_storage_object_allowed(text,text,text)'::regprocedure,
      'public.apps_get_tenant_storage_config(uuid,uuid)'::regprocedure)
      AND (acl.grantee NOT IN (current_user::regrole::oid,
        CASE WHEN p.proname = 'apps_storage_object_allowed' THEN 'authenticated'::regrole::oid
          ELSE 'service_role'::regrole::oid END)
        OR acl.is_grantable OR acl.privilege_type <> 'EXECUTE'))
  THEN
    RAISE EXCEPTION 'Apps Storage function privileges are not isolated';
  END IF;
END;
$install_storage$;

COMMIT;