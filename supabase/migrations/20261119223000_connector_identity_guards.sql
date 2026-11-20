-- Forward-only: browser instance metadata is not an assistant agent admission.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.guard_remote_instance_agent_assignment()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
    IF (TG_OP = 'INSERT' AND NEW.agent_id IS NOT NULL)
      OR (TG_OP = 'UPDATE' AND NEW.agent_id IS DISTINCT FROM OLD.agent_id) THEN
      RAISE EXCEPTION 'instance_agent_assignment_server_only' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_remote_instance_agent_assignment() FROM PUBLIC;
CREATE TRIGGER connector_instance_agent_assignment_guard
BEFORE INSERT OR UPDATE ON public.remote_instances
FOR EACH ROW EXECUTE FUNCTION public.guard_remote_instance_agent_assignment();

-- Historical attribution was browser-writable; do not certify or infer an owner.
ALTER TABLE public.instance_pending_work
  ADD COLUMN actor_verified boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.guard_pending_work_actor()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE actor uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.site_id IS DISTINCT FROM OLD.site_id
      OR NEW.instance_id IS DISTINCT FROM OLD.instance_id
      OR NEW.actor_verified IS DISTINCT FROM OLD.actor_verified THEN
      RAISE EXCEPTION 'pending_work_actor_immutable' USING ERRCODE = '42501';
    END IF;
    -- Another member must not replace an admitted actor's command.
    IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin')
      AND (OLD.user_id IS DISTINCT FROM auth.uid() OR NOT OLD.actor_verified) THEN
      RAISE EXCEPTION 'pending_work_actor_required' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
      actor := auth.uid();
      IF actor IS NULL OR (NEW.user_id IS NOT NULL AND NEW.user_id <> actor) THEN
        RAISE EXCEPTION 'pending_work_actor_mismatch' USING ERRCODE = '42501';
      END IF;
      NEW.user_id := actor;
    END IF;
    IF NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'pending_work_actor_required' USING ERRCODE = '42501';
    END IF;
    NEW.actor_verified := true;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.remote_instances i
    WHERE i.id = NEW.instance_id AND i.site_id = NEW.site_id) THEN
    RAISE EXCEPTION 'pending_work_instance_scope_mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_pending_work_actor() FROM PUBLIC;
CREATE TRIGGER connector_pending_work_actor_guard
BEFORE INSERT OR UPDATE ON public.instance_pending_work
FOR EACH ROW EXECUTE FUNCTION public.guard_pending_work_actor();

-- Recovery provenance is stored in log details. Browser log permissions must
-- not be able to manufacture a snapshot or transplant an admitted snapshot.
CREATE OR REPLACE FUNCTION public.guard_connector_recovery_provenance()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.details ? 'assistant_recovery' THEN
        RAISE EXCEPTION 'assistant_recovery_server_only' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.details->'assistant_recovery' IS DISTINCT FROM OLD.details->'assistant_recovery'
      OR (OLD.details ? 'assistant_recovery' AND (
        NEW.id IS DISTINCT FROM OLD.id OR NEW.instance_id IS DISTINCT FROM OLD.instance_id
        OR NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.log_type IS DISTINCT FROM OLD.log_type
        OR NEW.trusted_user_action IS DISTINCT FROM OLD.trusted_user_action)) THEN
      RAISE EXCEPTION 'assistant_recovery_server_only' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_connector_recovery_provenance() FROM PUBLIC;
CREATE TRIGGER connector_recovery_provenance_guard
BEFORE INSERT OR UPDATE ON public.instance_logs
FOR EACH ROW EXECUTE FUNCTION public.guard_connector_recovery_provenance();
COMMIT;