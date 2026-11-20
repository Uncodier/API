BEGIN;
SET LOCAL lock_timeout = '5s';

-- The constant default preserves all existing accounts' explicit grant semantics
-- and keeps direct inserts fail-closed. Verified finalization opts in on INSERT only.
ALTER TABLE public.connectors
  ADD COLUMN access_mode text NOT NULL DEFAULT 'explicit'
    CHECK (access_mode IN ('explicit', 'workspace'));
GRANT SELECT (access_mode) ON public.connectors TO authenticated;

CREATE FUNCTION public.connector_guard_access_mode()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.access_mode IS DISTINCT FROM OLD.access_mode THEN
    RAISE EXCEPTION 'Connector access mode is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_guard_access_mode() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER connector_access_mode_guard BEFORE UPDATE ON public.connectors
  FOR EACH ROW EXECUTE FUNCTION public.connector_guard_access_mode();

-- Internal shared browse decision. The manager exception is for metadata only;
-- it does not authorize tool use. A present grant never falls back to inheritance.
CREATE FUNCTION public.connector_effective_visible(
  p_site_id uuid, p_user_id uuid, p_connector_id uuid
) RETURNS SETOF public.connectors LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.*
  FROM public.connector_effective_site_access(p_site_id, p_user_id) a
  JOIN public.connectors c ON c.site_id = p_site_id
  LEFT JOIN public.connector_members m ON m.site_id = c.site_id AND m.connector_id = c.id AND m.user_id = p_user_id
  WHERE a.can_view AND (p_connector_id IS NULL OR c.id = p_connector_id)
    AND (a.can_manage OR CASE WHEN m.user_id IS NULL THEN c.access_mode = 'workspace'
      ELSE m.can_view AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp()) END);
$$;
REVOKE ALL ON FUNCTION public.connector_effective_visible(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.connector_visible(p_site_id uuid, p_connector_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_connector_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.connector_effective_visible(p_site_id, auth.uid(), p_connector_id));
$$;
REVOKE ALL ON FUNCTION public.connector_visible(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.connector_visible(uuid, uuid) TO authenticated;

-- Apply authorization before application-level ordering, projections and limits.
CREATE FUNCTION public.connector_list_visible(
  p_site_id uuid, p_user_id uuid, p_connector_id uuid DEFAULT NULL
) RETURNS SETOF public.connectors LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Connector service role required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.connector_effective_visible(p_site_id, p_user_id, p_connector_id);
END;
$$;
REVOKE ALL ON FUNCTION public.connector_list_visible(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_list_visible(uuid, uuid, uuid) TO service_role;

-- The API must verify the external account's project/user/status before calling.
-- This RPC atomically binds that proof and initializes only the new connector.
CREATE OR REPLACE FUNCTION public.connector_finalize_auth(
  p_attempt_id uuid, p_actor_id uuid, p_nonce_hash text, p_provider_account_id text,
  p_toolkit_slug text, p_auth_config_id text, p_display_name text, p_granted_scopes text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_attempt public.site_connector_auth_attempts%ROWTYPE;
  v_provider public.site_connector_providers%ROWTYPE; v_connector public.connectors%ROWTYPE;
  v_allowed_tools text[];
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
    -- Never reset mode, enabled/revoked state, grants, policy or metadata on replay.
    RETURN to_jsonb(v_connector);
  END IF;
  IF v_attempt.status <> 'completing' THEN
    RAISE EXCEPTION 'Connector auth attempt is not claimed' USING ERRCODE = '40001';
  END IF;
  -- Seed exact reviewed reads only, independently of live provider inventories.
  -- Runtime still verifies tool review, input, scope, agent and member eligibility.
  v_allowed_tools := CASE v_attempt.toolkit_slug
    WHEN 'gmail' THEN ARRAY['GMAIL_FETCH_EMAILS']
    WHEN 'hubspot' THEN ARRAY['HUBSPOT_LIST_CONTACTS']
    ELSE ARRAY[]::text[]
  END;
  INSERT INTO public.connectors(site_id, provider_id, toolkit_slug, provider_account_id,
    auth_config_id, display_name, provider_status, granted_scopes, created_by, verified_at,
    access_mode, enabled)
    VALUES (v_attempt.site_id, v_attempt.provider_id, v_attempt.toolkit_slug, p_provider_account_id,
      p_auth_config_id, p_display_name, 'ACTIVE', p_granted_scopes, p_actor_id, now(), 'workspace', true)
    RETURNING * INTO v_connector;
  INSERT INTO public.connector_policies(site_id, connector_id, allowed_tools, allowed_hosts, require_approval)
    VALUES (v_connector.site_id, v_connector.id, v_allowed_tools,
      CASE WHEN cardinality(v_allowed_tools) > 0 THEN ARRAY['assistant'] ELSE ARRAY[]::text[] END,
      cardinality(v_allowed_tools) = 0);
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