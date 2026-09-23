-- Rollback:
-- DROP FUNCTION IF EXISTS public.apps_ensure_tenant(
--   uuid, uuid, uuid, uuid, text
-- );

CREATE OR REPLACE FUNCTION public.apps_ensure_tenant(
  p_requirement_id uuid,
  p_candidate_tenant_id uuid,
  p_user_id uuid,
  p_site_id uuid,
  p_auth_provider text DEFAULT 'supabase'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  tenant_row public.apps_tenants%ROWTYPE;
  target_schema text;
  target_bucket text;
  owner_role text;
  was_created boolean := false;
BEGIN
  IF p_requirement_id IS NULL
    OR p_candidate_tenant_id IS NULL
    OR p_user_id IS NULL
    OR p_site_id IS NULL
    OR p_auth_provider NOT IN ('supabase', 'auth0')
  THEN
    RAISE EXCEPTION 'Invalid tenant provisioning payload';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('tenant:' || p_requirement_id::text, 0)
  );

  SELECT *
  INTO tenant_row
  FROM public.apps_tenants
  WHERE requirement_id = p_requirement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    target_schema :=
      'app_' || left(replace(p_requirement_id::text, '-', ''), 24);
    target_bucket :=
      'tenant-' || left(replace(p_requirement_id::text, '-', ''), 24);

    INSERT INTO public.apps_tenants (
      tenant_id,
      requirement_id,
      user_id,
      site_id,
      schema,
      bucket,
      auth_provider,
      status
    )
    VALUES (
      p_candidate_tenant_id,
      p_requirement_id,
      p_user_id,
      p_site_id,
      target_schema,
      target_bucket,
      p_auth_provider,
      'active'
    )
    RETURNING * INTO tenant_row;
    was_created := true;
  END IF;

  IF tenant_row.status <> 'active'
    OR tenant_row.schema !~ '^app_[a-f0-9]{24}$'
    OR tenant_row.bucket IS NULL
  THEN
    RAISE EXCEPTION 'Tenant registry row is not active and valid';
  END IF;

  target_schema := tenant_row.schema;
  target_bucket := tenant_row.bucket;
  owner_role := 'app_owner_' || substring(target_schema FROM 5);

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = owner_role
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

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace
    WHERE nspname = target_schema
  ) THEN
    EXECUTE format('CREATE SCHEMA %I', target_schema);
  END IF;

  EXECUTE format(
    'GRANT USAGE ON SCHEMA %I TO anon, authenticated',
    target_schema
  );
  EXECUTE format(
    'GRANT USAGE, CREATE ON SCHEMA %I TO %I',
    target_schema,
    owner_role
  );
  EXECUTE format(
    'GRANT USAGE ON SCHEMA %I TO apps_migration_coordinator',
    target_schema
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I
     GRANT ALL PRIVILEGES ON TABLES TO anon, authenticated',
    owner_role,
    target_schema
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I
     GRANT ALL PRIVILEGES ON ROUTINES TO anon, authenticated',
    owner_role,
    target_schema
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I
     GRANT ALL PRIVILEGES ON SEQUENCES TO anon, authenticated',
    owner_role,
    target_schema
  );

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I._meta (
       key text PRIMARY KEY,
       value jsonb NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )',
    target_schema
  );
  EXECUTE format(
    'ALTER TABLE %I._meta ENABLE ROW LEVEL SECURITY',
    target_schema
  );
  EXECUTE format(
    'DROP POLICY IF EXISTS tenant_isolation ON %I._meta',
    target_schema
  );
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I._meta USING (false)',
    target_schema
  );
  EXECUTE format(
    'INSERT INTO %I._meta (key, value)
     VALUES (
       ''provisioned'',
       jsonb_build_object(
         ''at'', now()::text,
         ''tenant_id'', $1
       )
     )
     ON CONFLICT (key) DO UPDATE
       SET value = excluded.value, updated_at = now()',
    target_schema
  )
  USING tenant_row.tenant_id;

  EXECUTE format(
    'ALTER TABLE %I._meta OWNER TO apps_migration_coordinator',
    target_schema
  );
  EXECUTE format(
    'ALTER SCHEMA %I OWNER TO %I',
    target_schema,
    owner_role
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
    target_schema,
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I._execute_tenant_migration(text) OWNER TO %I',
    target_schema,
    owner_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION %I._execute_tenant_migration(text)
     TO apps_migration_coordinator',
    target_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I._execute_tenant_migration(text)
     FROM PUBLIC, anon, authenticated, service_role',
    target_schema
  );

  RETURN jsonb_build_object(
    'tenant_id', tenant_row.tenant_id,
    'schema', target_schema,
    'bucket', target_bucket,
    'auth_provider', tenant_row.auth_provider,
    'created', was_created
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apps_ensure_tenant(
  uuid,
  uuid,
  uuid,
  uuid,
  text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.apps_ensure_tenant(
  uuid,
  uuid,
  uuid,
  uuid,
  text
) TO service_role;
