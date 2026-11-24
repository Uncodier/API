BEGIN;
SET LOCAL lock_timeout = '5s';

-- Provider-native slugs can start with an underscore (for example, _1password).
ALTER TABLE public.connectors
  DROP CONSTRAINT connectors_toolkit_slug_check,
  ADD CONSTRAINT connectors_toolkit_slug_check CHECK (toolkit_slug COLLATE "C" ~ '^[a-z0-9_][a-z0-9_-]{0,99}$');
ALTER TABLE public.site_connector_auth_attempts
  DROP CONSTRAINT site_connector_auth_attempts_toolkit_slug_check,
  ADD CONSTRAINT site_connector_auth_attempts_toolkit_slug_check CHECK (toolkit_slug COLLATE "C" ~ '^[a-z0-9_][a-z0-9_-]{0,99}$'),
  ADD COLUMN setup_mode text NOT NULL DEFAULT 'legacy',
  ADD CONSTRAINT connector_auth_setup_mode_check CHECK (
    setup_mode = 'legacy' OR (setup_mode IN ('hosted', 'hosted_credentials') AND NOT ask_on_connect AND supabase_project_ref IS NULL)
  );

-- Both current and older callbacks use the same finalizer. Enforce the hosted
-- policy inside the completion transaction, after policy insert and before the
-- auth_completed audit event. Do not rewrite existing accounts or legacy flows.
CREATE FUNCTION connector_result_private.guard_hosted_connection() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.setup_mode IS DISTINCT FROM OLD.setup_mode THEN
    RAISE EXCEPTION 'Connector setup mode is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status <> 'completing' OR NEW.connector_id IS NULL THEN
    RAISE EXCEPTION 'Hosted connection must be finalized from its claimed attempt' USING ERRCODE='23514';
  END IF;
  UPDATE public.connector_policies p SET allowed_hosts = '{}'
    FROM public.connectors c
    WHERE (p.site_id,p.connector_id) = (c.site_id,c.id)
      AND (c.id,c.site_id,c.provider_id,c.created_by,c.toolkit_slug,c.auth_config_id,c.provider_account_id) =
          (NEW.connector_id,OLD.site_id,OLD.provider_id,OLD.user_id,OLD.toolkit_slug,OLD.auth_config_id,OLD.provider_account_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hosted connection policy could not be bound' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.guard_hosted_connection() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_hosted_connection BEFORE UPDATE OF setup_mode, status ON public.site_connector_auth_attempts
  FOR EACH ROW WHEN (OLD.setup_mode IS DISTINCT FROM NEW.setup_mode OR
    (OLD.setup_mode IN ('hosted', 'hosted_credentials') AND NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status))
  EXECUTE FUNCTION connector_result_private.guard_hosted_connection();

COMMIT;