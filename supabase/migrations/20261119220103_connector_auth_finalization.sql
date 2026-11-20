BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.connector_guard_auth_attempt()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.site_id IS DISTINCT FROM OLD.site_id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.toolkit_slug IS DISTINCT FROM OLD.toolkit_slug OR NEW.auth_config_id IS DISTINCT FROM OLD.auth_config_id
    OR NEW.nonce_hash IS DISTINCT FROM OLD.nonce_hash
    OR NEW.credential_revision IS DISTINCT FROM OLD.credential_revision
    OR (NEW.expires_at IS DISTINCT FROM OLD.expires_at AND NOT (
      OLD.status = 'pending' AND NEW.status = 'pending' AND OLD.provider_account_id IS NULL
      AND NEW.provider_account_id IS NOT NULL AND NEW.expires_at <= OLD.expires_at
      AND NEW.expires_at > clock_timestamp()))
    OR (OLD.provider_account_id IS NOT NULL AND NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id)
    OR (OLD.connector_id IS NOT NULL AND NEW.connector_id IS DISTINCT FROM OLD.connector_id) THEN
    RAISE EXCEPTION 'Connector auth attempt identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('completing','failed','expired','outcome_unknown'))
    OR (OLD.status = 'completing' AND NEW.status IN ('completed','failed','expired','outcome_unknown'))
  ) THEN RAISE EXCEPTION 'Invalid connector auth transition' USING ERRCODE = '23514'; END IF;
  NEW.updated_at := now(); RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_guard_auth_attempt() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER connector_auth_attempt_guard BEFORE UPDATE ON public.site_connector_auth_attempts
  FOR EACH ROW EXECUTE FUNCTION public.connector_guard_auth_attempt();

-- The API must verify the external account's project/user/status before calling.
-- This RPC atomically binds that proof to the previously claimed local attempt.
CREATE FUNCTION public.connector_finalize_auth(
  p_attempt_id uuid, p_actor_id uuid, p_nonce_hash text, p_provider_account_id text,
  p_toolkit_slug text, p_auth_config_id text, p_display_name text, p_granted_scopes text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_attempt public.site_connector_auth_attempts%ROWTYPE;
  v_provider public.site_connector_providers%ROWTYPE; v_connector public.connectors%ROWTYPE;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Connector service role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_attempt FROM public.site_connector_auth_attempts a WHERE a.id = p_attempt_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.user_id IS DISTINCT FROM p_actor_id
    OR v_attempt.nonce_hash IS DISTINCT FROM p_nonce_hash OR v_attempt.expires_at <= clock_timestamp()
    OR v_attempt.toolkit_slug IS DISTINCT FROM p_toolkit_slug
    OR v_attempt.auth_config_id IS DISTINCT FROM p_auth_config_id
    OR v_attempt.provider_account_id IS DISTINCT FROM p_provider_account_id
    OR p_provider_account_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.connector_effective_site_access(v_attempt.site_id, p_actor_id) a
      WHERE a.can_manage) THEN
    RAISE EXCEPTION 'Connector auth attempt denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_provider FROM public.site_connector_providers p
    WHERE p.id = v_attempt.provider_id AND p.site_id = v_attempt.site_id FOR SHARE;
  IF NOT FOUND OR v_provider.status <> 'active'
    OR v_provider.credential_revision <> v_attempt.credential_revision THEN
    RAISE EXCEPTION 'Connector credentials changed' USING ERRCODE = '40001';
  END IF;
  IF v_attempt.status = 'completed' THEN
    SELECT * INTO v_connector FROM public.connectors c
      WHERE c.id = v_attempt.connector_id AND c.site_id = v_attempt.site_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Connector auth result unavailable' USING ERRCODE = '42501'; END IF;
    -- Never reset enabled, revoked state, grants, policy or display metadata on replay.
    RETURN to_jsonb(v_connector);
  END IF;
  IF v_attempt.status <> 'completing' THEN
    RAISE EXCEPTION 'Connector auth attempt is not claimed' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.connectors(site_id, provider_id, toolkit_slug, provider_account_id,
    auth_config_id, display_name, provider_status, granted_scopes, created_by, verified_at)
    VALUES (v_attempt.site_id, v_attempt.provider_id, p_toolkit_slug, p_provider_account_id,
      p_auth_config_id, p_display_name, 'ACTIVE', p_granted_scopes, p_actor_id, now())
    RETURNING * INTO v_connector;
  INSERT INTO public.connector_policies(site_id, connector_id) VALUES (v_connector.site_id, v_connector.id);
  UPDATE public.site_connector_auth_attempts SET status = 'completed', connector_id = v_connector.id,
    updated_at = now() WHERE id = p_attempt_id;
  INSERT INTO public.connector_audit_events(site_id, connector_id, actor_id, event_type, revision)
    VALUES (v_connector.site_id, v_connector.id, p_actor_id, 'auth_completed', v_connector.revision);
  RETURN to_jsonb(v_connector);
END;
$$;
REVOKE ALL ON FUNCTION public.connector_finalize_auth(uuid, uuid, text, text, text, text, text, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_finalize_auth(uuid, uuid, text, text, text, text, text, text[])
  TO service_role;

COMMIT;