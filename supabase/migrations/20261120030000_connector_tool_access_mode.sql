BEGIN;
SET LOCAL lock_timeout = '5s';

-- No policy rewrite: retain existing selections, hosts, approvals and revisions.
ALTER TABLE public.connector_policies
  ADD COLUMN tool_access_mode text NOT NULL DEFAULT 'selected'
    CHECK (tool_access_mode IN ('selected', 'all'));
COMMENT ON COLUMN public.connector_policies.tool_access_mode IS
  'all covers compatible reviewed tools only; neither mode bypasses runtime authorization.';

-- One unambiguous PostgREST signature. Omitting mode always means selected,
-- even when an older client edits a connection that was initialized in all mode.
DROP FUNCTION public.connector_update_policy(uuid, uuid, uuid, integer, text[], text[], boolean, boolean);
CREATE FUNCTION public.connector_update_policy(
  p_site_id uuid, p_connector_id uuid, p_actor_id uuid, p_expected_revision integer,
  p_allowed_tools text[], p_allowed_hosts text[], p_require_approval boolean,
  p_enabled boolean DEFAULT NULL, p_tool_access_mode text DEFAULT 'selected'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_revision integer; v_policy_revision integer;
BEGIN
  v_revision := public.connector_lock_for_manager(p_site_id, p_connector_id, p_actor_id, p_expected_revision);
  IF public.connector_valid_text_array(p_allowed_tools, 200, '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$') IS NOT TRUE
    OR public.connector_valid_text_array(p_allowed_hosts, 2, '^(assistant|direct)$') IS NOT TRUE
    OR p_require_approval IS NULL OR p_tool_access_mode IS NULL OR p_tool_access_mode NOT IN ('selected', 'all') THEN
    RAISE EXCEPTION 'Invalid connector policy' USING ERRCODE = '22023';
  END IF;
  IF p_enabled IS TRUE AND NOT EXISTS (
    SELECT 1 FROM public.connectors c JOIN public.site_connector_providers p
      ON p.id = c.provider_id AND p.site_id = c.site_id
    WHERE c.id = p_connector_id AND c.site_id = p_site_id AND c.provider_status = 'ACTIVE'
      AND c.verified_at IS NOT NULL AND NOT c.revocation_pending AND p.status = 'active'
  ) THEN RAISE EXCEPTION 'Connector is not ready' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.connector_policies(site_id, connector_id, allowed_tools, allowed_hosts, require_approval, tool_access_mode)
    VALUES (p_site_id, p_connector_id, p_allowed_tools, p_allowed_hosts, p_require_approval, p_tool_access_mode)
    ON CONFLICT (connector_id) DO UPDATE SET allowed_tools = EXCLUDED.allowed_tools,
      allowed_hosts = EXCLUDED.allowed_hosts, require_approval = EXCLUDED.require_approval,
      tool_access_mode = EXCLUDED.tool_access_mode,
      revision = public.connector_policies.revision + 1, updated_at = now()
    RETURNING revision INTO v_policy_revision;
  UPDATE public.connectors SET revision = v_revision + 1, enabled = coalesce(p_enabled, enabled), updated_at = now()
    WHERE id = p_connector_id AND site_id = p_site_id;
  INSERT INTO public.connector_audit_events(site_id, connector_id, actor_id, event_type, revision)
    VALUES (p_site_id, p_connector_id, p_actor_id, 'policy_updated', v_revision + 1);
  RETURN jsonb_build_object('connector_id', p_connector_id, 'revision', v_revision + 1,
    'policy_revision', v_policy_revision);
END;
$$;
REVOKE ALL ON FUNCTION public.connector_update_policy(uuid, uuid, uuid, integer, text[], text[], boolean, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_update_policy(uuid, uuid, uuid, integer, text[], text[], boolean, boolean, text)
  TO service_role;

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
  -- Preserve selected-mode fallback IDs and existing toolkit approval defaults.
  -- The runtime resolves all mode through its reviewed, toolkit-bound registry.
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
  INSERT INTO public.connector_policies(site_id, connector_id, allowed_tools, allowed_hosts, require_approval, tool_access_mode)
    VALUES (v_connector.site_id, v_connector.id, v_allowed_tools, ARRAY['assistant'], cardinality(v_allowed_tools) = 0, 'all');
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
