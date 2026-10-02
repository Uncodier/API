-- Apps Supabase ONLY. Forward-only observed-file journal; NOT workflow state.
-- Requires the isolated tenant bootstrap and atomic migration RPCs. Applied
-- receipts remain exclusively authoritative in each tenant's protected _meta.
-- No tenant SQL is executed here; apps_apply_migration is deliberately unchanged.
BEGIN;

DO $prerequisites$
BEGIN
  IF to_regclass('public.apps_tenants') IS NULL
    OR to_regprocedure('public.apps_apply_migration(text,uuid,text,text,text)') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = 'apps_migration_coordinator'
        AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb
          OR rolcreaterole OR rolreplication OR rolbypassrls)
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = pg_roles.oid
        )
    )
  THEN
    RAISE EXCEPTION 'Apps migration feedback requires the isolated Apps bootstrap';
  END IF;
END;
$prerequisites$;

CREATE TABLE public.apps_migration_feedback (
  target_schema text NOT NULL CHECK (target_schema ~ '^app_[a-f0-9]{24}$'),
  migration_key text NOT NULL CHECK (
    -- The host accepts at most 512 path bytes, plus the migration: prefix.
    octet_length(migration_key) <= 522
    AND migration_key ~ '^migration:(migrations|supabase/migrations|src/db/migrations|platform)/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*[.]sql$'
    AND migration_key !~ '(^|/)[.]{1,2}(/|$)'
    AND migration_key NOT LIKE '%//%'
  ),
  tenant_id uuid NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  context_key text NOT NULL CHECK (octet_length(context_key) BETWEEN 1 AND 256),
  -- The trusted host redacts diagnostics before this RPC. SQL enforces shape and
  -- a small byte ceiling, not a second secret-redaction implementation.
  error jsonb CHECK (
    error IS NULL OR (jsonb_typeof(error) = 'object' AND octet_length(error::text) <= 4096)
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_schema, migration_key)
);

ALTER TABLE public.apps_migration_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.apps_migration_feedback FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.apps_migration_feedback TO service_role;
CREATE POLICY apps_migration_feedback_service_read
  ON public.apps_migration_feedback FOR SELECT TO service_role USING (true);

-- Ownership transfers require CREATE on the containing schema. This temporary
-- grant is removed below, as in the original atomic migration installation.
GRANT USAGE, CREATE ON SCHEMA public TO apps_migration_coordinator;
ALTER TABLE public.apps_migration_feedback OWNER TO apps_migration_coordinator;

CREATE FUNCTION public.apps_get_migration_workspace(
  p_target_schema text,
  p_expected_tenant_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  namespace_oid oid;
  owner_oid oid;
  coordinator_oid oid := to_regrole('apps_migration_coordinator')::oid;
  fingerprint text;
  files jsonb;
  receipts jsonb;
BEGIN
  IF p_target_schema IS NULL OR p_target_schema !~ '^app_[a-f0-9]{24}$'
    OR p_expected_tenant_id IS NULL
  THEN
    RAISE EXCEPTION 'Invalid migration workspace binding';
  END IF;

  -- Same seed and whole-schema stream as apps_apply_migration, including reads
  -- so structural feedback and receipts cannot straddle a coordinated apply.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_target_schema, 0));
  IF NOT EXISTS (
    SELECT 1 FROM public.apps_tenants
    WHERE tenant_id = p_expected_tenant_id AND schema = p_target_schema AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Tenant and schema do not match an active tenant';
  END IF;

  SELECT n.oid, r.oid INTO namespace_oid, owner_oid
  FROM pg_catalog.pg_namespace AS n
  JOIN pg_catalog.pg_roles AS r ON r.oid = n.nspowner
  WHERE n.nspname = p_target_schema
    AND r.rolname = 'app_owner_' || substring(p_target_schema FROM 5)
    AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
      OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid);
  IF namespace_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE relnamespace = namespace_oid AND relname = '_meta' AND relkind = 'r'
      AND relowner = coordinator_oid AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Migration workspace requires an isolated schema and protected receipts';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.apps_migration_feedback
    WHERE target_schema = p_target_schema AND tenant_id <> p_expected_tenant_id
  ) THEN
    RAISE EXCEPTION 'Migration feedback tenant binding changed';
  END IF;

  -- MD5 is a deterministic 32-hex cache-context identifier, NOT a migration
  -- checksum or integrity proof. No extensions required. Only catalog structure
  -- is read: no tenant rows, sequence counters, statistics or receipt contents.
  -- Ordered JSON definitions avoid catalog OIDs and ambiguous concatenation.
  WITH definitions(kind, name, definition) AS (
    SELECT 'schema', n.nspname::text, jsonb_build_array(
      pg_get_userbyid(n.nspowner), ARRAY(SELECT x::text FROM unnest(n.nspacl) x ORDER BY x::text)
    ) FROM pg_catalog.pg_namespace n WHERE n.oid = namespace_oid
    UNION ALL
    SELECT 'relation', c.relname::text, jsonb_build_array(
      c.relkind, c.relpersistence, pg_get_userbyid(c.relowner), c.relrowsecurity,
      c.relforcerowsecurity, c.relreplident,
      ARRAY(SELECT x FROM unnest(c.reloptions) x ORDER BY x),
      ARRAY(SELECT x::text FROM unnest(c.relacl) x ORDER BY x::text),
      CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, false) END,
      CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
      pg_get_expr(c.relpartbound, c.oid, false)
    ) FROM pg_catalog.pg_class c WHERE c.relnamespace = namespace_oid
    UNION ALL
    SELECT 'column', c.relname || '.' || a.attnum::text, jsonb_build_array(
      a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
      a.attidentity, a.attgenerated, a.attstorage, a.attcompression,
      a.attcollation::regcollation::text, pg_get_expr(d.adbin, d.adrelid, false),
      ARRAY(SELECT x::text FROM unnest(a.attacl) x ORDER BY x::text)
    ) FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE c.relnamespace = namespace_oid AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'constraint', c.conrelid::regclass::text || ':' || c.conname,
      jsonb_build_array(c.contype, c.convalidated, pg_get_constraintdef(c.oid, false))
    FROM pg_catalog.pg_constraint c WHERE c.connamespace = namespace_oid
    UNION ALL
    SELECT 'index', c.relname::text, to_jsonb(pg_get_indexdef(i.indexrelid))
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    WHERE c.relnamespace = namespace_oid
    UNION ALL
    SELECT 'policy', c.relname || ':' || p.polname, jsonb_build_array(
      p.polcmd, p.polpermissive,
      ARRAY(SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END
        FROM unnest(p.polroles) r ORDER BY 1),
      pg_get_expr(p.polqual, p.polrelid, false), pg_get_expr(p.polwithcheck, p.polrelid, false)
    ) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    WHERE c.relnamespace = namespace_oid
    UNION ALL
    SELECT 'routine', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
      jsonb_build_array(pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner),
        ARRAY(SELECT x::text FROM unnest(p.proacl) x ORDER BY x::text))
    FROM pg_catalog.pg_proc p WHERE p.pronamespace = namespace_oid AND p.prokind <> 'a'
    UNION ALL
    SELECT 'type', t.typname::text, jsonb_build_array(
      t.typtype, pg_get_userbyid(t.typowner), t.typnotnull,
      format_type(t.typbasetype, t.typtypmod), t.typdefault,
      ARRAY(SELECT x::text FROM unnest(t.typacl) x ORDER BY x::text),
      ARRAY(SELECT e.enumlabel FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder),
      (SELECT jsonb_build_array(format_type(r.rngsubtype, NULL), r.rngcollation::regcollation::text,
        r.rngcanonical::regprocedure::text, r.rngsubdiff::regprocedure::text)
        FROM pg_catalog.pg_range r WHERE r.rngtypid = t.oid)
    ) FROM pg_catalog.pg_type t WHERE t.typnamespace = namespace_oid
    UNION ALL
    SELECT 'trigger', c.relname || ':' || t.tgname,
      jsonb_build_array(t.tgenabled, pg_get_triggerdef(t.oid, false))
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = namespace_oid AND NOT t.tgisinternal
    UNION ALL
    SELECT 'rule', c.relname || ':' || r.rulename,
      jsonb_build_array(r.ev_enabled, pg_get_ruledef(r.oid, false))
    FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class
    WHERE c.relnamespace = namespace_oid
    UNION ALL
    SELECT 'sequence', c.relname::text, jsonb_build_array(
      format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, s.seqmax, s.seqmin, s.seqcache, s.seqcycle
    ) FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
    WHERE c.relnamespace = namespace_oid
    UNION ALL
    SELECT 'default_acl', pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text,
      to_jsonb(ARRAY(SELECT x::text FROM unnest(d.defaclacl) x ORDER BY x::text))
    FROM pg_catalog.pg_default_acl d
    WHERE d.defaclnamespace = namespace_oid OR (d.defaclnamespace = 0 AND d.defaclrole = owner_oid)
    UNION ALL
    SELECT 'role', r.rolname::text, jsonb_build_array(
      r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
      r.rolreplication, r.rolbypassrls, r.rolconnlimit,
      ARRAY(SELECT x FROM unnest(r.rolconfig) x ORDER BY x)
    ) FROM pg_catalog.pg_roles r
    WHERE r.oid IN (owner_oid, coordinator_oid) OR r.rolname IN ('anon', 'authenticated', 'service_role')
    UNION ALL
    SELECT 'membership', pg_get_userbyid(m.roleid) || ':' || pg_get_userbyid(m.member),
      jsonb_build_array(m.admin_option, m.inherit_option, m.set_option)
    FROM pg_catalog.pg_auth_members m
    WHERE m.member IN (SELECT oid FROM pg_catalog.pg_roles
      WHERE oid IN (owner_oid, coordinator_oid) OR rolname IN ('anon', 'authenticated', 'service_role'))
  )
  SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(kind, name, definition)
    ORDER BY kind COLLATE "C", name COLLATE "C", definition::text COLLATE "C"), '[]'::jsonb)::text)
  INTO fingerprint FROM definitions;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'migration_key', f.migration_key, 'checksum', f.checksum,
    'context_key', f.context_key, 'error', f.error
  ) ORDER BY f.migration_key COLLATE "C"), '[]'::jsonb)
  INTO files FROM public.apps_migration_feedback f
  WHERE f.target_schema = p_target_schema AND f.tenant_id = p_expected_tenant_id;

  -- Include every applied key, even historical paths the new journal rejects.
  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(jsonb_build_object(''migration_key'', key, ''value'', value)
       ORDER BY key COLLATE "C"), ''[]''::jsonb) FROM %I._meta WHERE key LIKE ''migration:%%''',
    p_target_schema
  ) INTO receipts;
  RETURN jsonb_build_object('schema_fingerprint', fingerprint, 'files', files, 'receipts', receipts);
END;
$function$;

REVOKE ALL ON FUNCTION public.apps_get_migration_workspace(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apps_get_migration_workspace(text, uuid) TO service_role;
ALTER FUNCTION public.apps_get_migration_workspace(text, uuid) OWNER TO apps_migration_coordinator;

CREATE FUNCTION public.apps_record_migration_feedback(
  p_target_schema text,
  p_expected_tenant_id uuid,
  p_migration_key text,
  p_migration_checksum text,
  p_context_key text,
  p_error jsonb DEFAULT NULL
)
RETURNS public.apps_migration_feedback
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  namespace_oid oid;
  existing_receipt jsonb;
  result public.apps_migration_feedback%ROWTYPE;
BEGIN
  IF p_target_schema IS NULL OR p_target_schema !~ '^app_[a-f0-9]{24}$'
    OR p_expected_tenant_id IS NULL
    OR p_migration_key IS NULL OR octet_length(p_migration_key) > 522
    OR p_migration_key !~ '^migration:(migrations|supabase/migrations|src/db/migrations|platform)/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*[.]sql$'
    OR p_migration_key ~ '(^|/)[.]{1,2}(/|$)' OR p_migration_key LIKE '%//%'
    OR p_migration_checksum IS NULL OR p_migration_checksum !~ '^[a-f0-9]{64}$'
    OR p_context_key IS NULL OR octet_length(p_context_key) NOT BETWEEN 1 AND 256
    OR (p_error IS NOT NULL AND (jsonb_typeof(p_error) <> 'object' OR octet_length(p_error::text) > 4096))
  THEN
    RAISE EXCEPTION 'Invalid migration feedback payload';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_target_schema, 0));
  IF NOT EXISTS (
    SELECT 1 FROM public.apps_tenants
    WHERE tenant_id = p_expected_tenant_id AND schema = p_target_schema AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Tenant and schema do not match an active tenant';
  END IF;
  SELECT n.oid INTO namespace_oid
  FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
  WHERE n.nspname = p_target_schema
    AND r.rolname = 'app_owner_' || substring(p_target_schema FROM 5)
    AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
      OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid);
  IF namespace_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE relnamespace = namespace_oid AND relname = '_meta' AND relkind = 'r'
      AND relowner = to_regrole('apps_migration_coordinator')::oid AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Migration feedback requires an isolated schema and protected receipts';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.apps_migration_feedback
    WHERE target_schema = p_target_schema AND tenant_id <> p_expected_tenant_id
  ) THEN
    RAISE EXCEPTION 'Migration feedback tenant binding changed';
  END IF;

  EXECUTE format('SELECT jsonb_build_object(''value'', value) FROM %I._meta WHERE key = $1', p_target_schema)
    INTO existing_receipt USING p_migration_key;
  IF existing_receipt IS NOT NULL THEN
    -- Fail closed on legacy receipts without a checksum. Never backfill, replace,
    -- clear a diagnostic, or otherwise mutate an already-applied file here.
    IF existing_receipt->'value'->>'checksum' IS DISTINCT FROM p_migration_checksum THEN
      RAISE EXCEPTION 'Migration % changed after application or has no verifiable checksum', p_migration_key;
    END IF;
    result := ROW(p_target_schema, p_migration_key, p_expected_tenant_id,
      p_migration_checksum, p_context_key, p_error, now())::public.apps_migration_feedback;
    RETURN result;
  END IF;

  INSERT INTO public.apps_migration_feedback AS f (
    target_schema, migration_key, tenant_id, checksum, context_key, error, updated_at
  ) VALUES (
    p_target_schema, p_migration_key, p_expected_tenant_id,
    p_migration_checksum, p_context_key, p_error, now()
  ) ON CONFLICT (target_schema, migration_key) DO UPDATE SET
    checksum = EXCLUDED.checksum, context_key = EXCLUDED.context_key,
    error = EXCLUDED.error, updated_at = EXCLUDED.updated_at
  WHERE f.tenant_id = EXCLUDED.tenant_id
  RETURNING f.* INTO result;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Migration feedback tenant binding changed';
  END IF;
  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.apps_record_migration_feedback(text, uuid, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apps_record_migration_feedback(text, uuid, text, text, text, jsonb)
  TO service_role;
ALTER FUNCTION public.apps_record_migration_feedback(text, uuid, text, text, text, jsonb)
  OWNER TO apps_migration_coordinator;

-- A separate, retryable cache invalidation after confirmed application. This
-- does not apply SQL, rewrite receipts or change PostgREST configuration.
CREATE FUNCTION public.apps_reload_migration_schema(
  p_target_schema text,
  p_expected_tenant_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  -- Reuse the exact active binding, isolated schema/ledger trust and stream
  -- lock checks rather than introducing a weaker cache-reload authorization.
  PERFORM public.apps_get_migration_workspace(p_target_schema, p_expected_tenant_id);
  PERFORM pg_catalog.pg_notify('pgrst', 'reload schema');
END;
$function$;

REVOKE ALL ON FUNCTION public.apps_reload_migration_schema(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apps_reload_migration_schema(text, uuid) TO service_role;
ALTER FUNCTION public.apps_reload_migration_schema(text, uuid) OWNER TO apps_migration_coordinator;
REVOKE CREATE ON SCHEMA public FROM apps_migration_coordinator;

COMMIT;