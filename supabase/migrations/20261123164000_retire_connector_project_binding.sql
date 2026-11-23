BEGIN;
SET LOCAL lock_timeout = '5s';

-- Project references are set only at connection creation. Retire the legacy
-- post-connection writer without changing any existing account or permission.
CREATE OR REPLACE FUNCTION public.connector_guard_supabase_project_ref()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.supabase_project_ref IS DISTINCT FROM OLD.supabase_project_ref THEN
    RAISE EXCEPTION 'Connector project binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION public.connector_bind_supabase_project(uuid,uuid,uuid,integer,text,text);
COMMIT;