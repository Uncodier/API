                                -- Rollback:
-- DROP FUNCTION IF EXISTS public.apps_apply_migration(text, uuid, text, text, text);
-- DROP FUNCTION IF EXISTS public.apps_get_migration_receipt(text, uuid, text);
-- Reassign each tenant schema before dropping its app_owner_<schema suffix>
-- role. The per-tenant executor is intentionally not restored.

DO $coordinator_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'apps_migration_coordinator'
  ) THEN
    CREATE ROLE apps_migration_coordinator
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$coordinator_role$;

ALTER ROLE apps_migration_coordinator
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO apps_migration_coordinator;
GRANT SELECT ON TABLE public.apps_tenants TO apps_migration_coordinator;

-- Existing tenant objects were created by the unrestricted bootstrap RPC.
-- Give every tenant a distinct constrained owner and private SQL executor.
DO $tenant_ownership$
DECLARE
  tenant_schema record;
  tenant_object record;
  tenant_routine record;
  tenant_type record;
  owner_role text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_catalog.pg_namespace
    WHERE nspname ~ '^app_[a-f0-9]{24}$'
  LOOP
    owner_role := 'app_owner_' || substring(tenant_schema.nspname FROM 5);
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles
      WHERE rolname = owner_role
    ) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
         NOCREATEROLE NOREPLICATION NOBYPASSRLS',
        owner_role
      );
    END IF;
    EXECUTE format(
      'ALTER ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
       NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      owner_role
    );

    FOR tenant_object IN
      SELECT c.relname, c.relkind
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = tenant_schema.nspname
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
        AND c.relname <> '_meta'
    LOOP
      EXECUTE format(
        CASE tenant_object.relkind
          WHEN 'v' THEN 'ALTER VIEW %I.%I OWNER TO %I'
          WHEN 'm' THEN
            'ALTER MATERIALIZED VIEW %I.%I OWNER TO %I'
          WHEN 'S' THEN 'ALTER SEQUENCE %I.%I OWNER TO %I'
          WHEN 'f' THEN 'ALTER FOREIGN TABLE %I.%I OWNER TO %I'
          WHEN 'c' THEN 'ALTER TYPE %I.%I OWNER TO %I'
          ELSE 'ALTER TABLE %I.%I OWNER TO %I'
        END,
        tenant_schema.nspname,
        tenant_object.relname,
        owner_role
      );
      IF tenant_object.relkind = 'v' THEN
        EXECUTE format(
          'ALTER VIEW %I.%I SET (security_invoker = true)',
          tenant_schema.nspname,
          tenant_object.relname
        );
      ELSIF tenant_object.relkind = 'm' THEN
        EXECUTE format(
          'REVOKE ALL ON TABLE %I.%I FROM anon, authenticated',
          tenant_schema.nspname,
          tenant_object.relname
        );
      END IF;
    END LOOP;

    FOR tenant_routine IN
      SELECT
        p.proname,
        p.prosecdef,
        pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = tenant_schema.nspname
        AND p.prokind IN ('f', 'p')
    LOOP
      EXECUTE format(
        'ALTER ROUTINE %I.%I(%s) OWNER TO %I',
        tenant_schema.nspname,
        tenant_routine.proname,
        tenant_routine.arguments,
        owner_role
      );
      IF tenant_routine.prosecdef THEN
        EXECUTE format(
          'ALTER ROUTINE %I.%I(%s) SECURITY INVOKER',
          tenant_schema.nspname,
          tenant_routine.proname,
          tenant_routine.arguments
        );
      END IF;
    END LOOP;

    FOR tenant_type IN
      SELECT t.typname, t.typtype
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = tenant_schema.nspname
        AND t.typrelid = 0
        AND t.typtype IN ('d', 'e', 'r', 'm')
    LOOP
      EXECUTE format(
        CASE tenant_type.typtype
          WHEN 'd' THEN 'ALTER DOMAIN %I.%I OWNER TO %I'
          ELSE 'ALTER TYPE %I.%I OWNER TO %I'
        END,
        tenant_schema.nspname,
        tenant_type.typname,
        owner_role
      );
    END LOOP;

    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I
       GRANT ALL PRIVILEGES ON TABLES TO anon, authenticated',
      owner_role,
      tenant_schema.nspname
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I
       GRANT ALL PRIVILEGES ON ROUTINES TO anon, authenticated',
      owner_role,
      tenant_schema.nspname
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I
       GRANT ALL PRIVILEGES ON SEQUENCES TO anon, authenticated',
      owner_role,
      tenant_schema.nspname
    );
    EXECUTE format(
      'ALTER SCHEMA %I OWNER TO %I',
      tenant_schema.nspname,
      owner_role
    );
    EXECUTE format(
      'GRANT USAGE ON SCHEMA %I TO apps_migration_coordinator',
      tenant_schema.nspname
    );
    EXECUTE format(
      'ALTER TABLE %I._meta OWNER TO apps_migration_coordinator',
      tenant_schema.nspname
    );

    EXECUTE format(
      $executor$
      CREATE OR REPLACE FUNCTION %I._execute_tenant_migration(p_sql text)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = %I, pg_catalog
      AS $body$
      BEGIN
        IF p_sql IS NULL OR length(trim(p_sql)) = 0 THEN
          RAISE EXCEPTION 'Empty tenant migration SQL';
        END IF;
        EXECUTE p_sql;
      END;
      $body$
      $executor$,
      tenant_schema.nspname,
      tenant_schema.nspname
    );
    EXECUTE format(
      'ALTER FUNCTION %I._execute_tenant_migration(text) OWNER TO %I',
      tenant_schema.nspname,
      owner_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I._execute_tenant_migration(text)
       TO apps_migration_coordinator',
      tenant_schema.nspname
    );
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I._execute_tenant_migration(text)
       FROM PUBLIC, anon, authenticated, service_role',
      tenant_schema.nspname
    );
  END LOOP;
END;
$tenant_ownership$;

CREATE OR REPLACE FUNCTION public.apps_get_migration_receipt(
  p_target_schema text,
  p_expected_tenant_id uuid,
  p_migration_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  receipt jsonb;
BEGIN
  IF p_target_schema !~ '^app_[a-f0-9]{24}$'
    OR p_migration_key !~ '^migration:[A-Za-z0-9_./-]+\.sql$'
  THEN
    RAISE EXCEPTION 'Invalid migration lookup';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.apps_tenants
    WHERE tenant_id = p_expected_tenant_id
      AND schema = p_target_schema
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Tenant and schema do not match an active tenant';
  END IF;

  EXECUTE format(
    'SELECT jsonb_build_object(''found'', true, ''value'', value)
       FROM %I._meta
      WHERE key = $1',
    p_target_schema
  )
  INTO receipt
  USING p_migration_key;

  RETURN COALESCE(receipt, jsonb_build_object('found', false));
END;
$function$;

ALTER FUNCTION public.apps_get_migration_receipt(
  text,
  uuid,
  text
) OWNER TO apps_migration_coordinator;

REVOKE ALL ON FUNCTION public.apps_get_migration_receipt(
  text,
  uuid,
  text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.apps_get_migration_receipt(
  text,
  uuid,
  text
) TO service_role;

CREATE OR REPLACE FUNCTION public.apps_apply_migration(
  p_target_schema text,
  p_expected_tenant_id uuid,
  p_migration_key text,
  p_migration_checksum text,
  p_migration_sql text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  existing_value jsonb;
  existing_checksum_key text;
BEGIN
  IF p_target_schema !~ '^app_[a-f0-9]{24}$' THEN
    RAISE EXCEPTION 'Invalid tenant schema';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.apps_tenants
    WHERE tenant_id = p_expected_tenant_id
      AND schema = p_target_schema
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Tenant and schema do not match an active tenant';
  END IF;

  IF p_migration_key !~ '^migration:[A-Za-z0-9_./-]+\.sql$'
    OR p_migration_sql IS NULL
    OR length(trim(p_migration_sql)) = 0
    OR p_migration_checksum !~ '^[a-f0-9]{64}$'
  THEN
    RAISE EXCEPTION 'Invalid migration payload';
  END IF;

  -- Serialize the whole tenant migration stream. Locking only by filename
  -- would allow the same SQL to run concurrently under two renamed files.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_target_schema, 0));

  EXECUTE format(
    'SELECT value FROM %I._meta WHERE key = $1 FOR UPDATE',
    p_target_schema
  )
  INTO existing_value
  USING p_migration_key;

  IF existing_value IS NOT NULL THEN
    IF (existing_value ? 'checksum')
      AND existing_value->>'checksum' <> p_migration_checksum
    THEN
      RAISE EXCEPTION
        'Migration % changed after application',
        p_migration_key;
    END IF;

    IF NOT (existing_value ? 'checksum') THEN
      EXECUTE format(
        'UPDATE %I._meta
         SET value = value || jsonb_build_object(
           ''checksum'', $1,
           ''checksum_backfilled_at'', now()::text
         ),
         updated_at = now()
         WHERE key = $2',
        p_target_schema
      )
      USING p_migration_checksum, p_migration_key;
    END IF;
    RETURN false;
  END IF;

  EXECUTE format(
    'SELECT key
       FROM %I._meta
      WHERE key LIKE ''migration:%%''
        AND value->>''checksum'' = $1
      LIMIT 1',
    p_target_schema
  )
  INTO existing_checksum_key
  USING p_migration_checksum;

  -- A rename must not turn already-applied SQL into a pending migration.
  IF existing_checksum_key IS NOT NULL THEN
    RETURN false;
  END IF;

  -- The outer SECURITY DEFINER function only coordinates trusted metadata.
  -- User SQL runs inside the tenant-local executor owned by that tenant's
  -- constrained role, never as this function's privileged owner.
  EXECUTE format(
    'SELECT %I._execute_tenant_migration($1)',
    p_target_schema
  )
  USING p_migration_sql;

  EXECUTE format(
    'INSERT INTO %I._meta (key, value)
     VALUES ($1, jsonb_build_object(
       ''applied_at'', now()::text,
       ''checksum'', $2
     ))',
    p_target_schema
  )
  USING p_migration_key, p_migration_checksum;

  RETURN true;
END;
$function$;

ALTER FUNCTION public.apps_apply_migration(
  text,
  uuid,
  text,
  text,
  text
) OWNER TO apps_migration_coordinator;

REVOKE ALL ON FUNCTION public.apps_apply_migration(
  text,
  uuid,
  text,
  text,
  text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.apps_apply_migration(
  text,
  uuid,
  text,
  text,
  text
) TO service_role;
