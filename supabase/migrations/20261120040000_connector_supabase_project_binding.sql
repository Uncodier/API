BEGIN;
SET LOCAL lock_timeout = '5s';

-- Only the API token setup path writes a project it independently verified.
-- Old and OAuth accounts stay unbound. Never infer identity from a display name.
ALTER TABLE public.site_connector_auth_attempts ADD COLUMN supabase_project_ref text
  CHECK (supabase_project_ref IS NULL OR (toolkit_slug = 'supabase' AND supabase_project_ref ~ '^[a-z0-9]{20}$'));
ALTER TABLE public.connectors ADD COLUMN supabase_project_ref text
  CHECK (supabase_project_ref IS NULL OR (toolkit_slug = 'supabase' AND supabase_project_ref ~ '^[a-z0-9]{20}$'));

CREATE FUNCTION public.connector_guard_supabase_project_ref()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.supabase_project_ref IS DISTINCT FROM OLD.supabase_project_ref THEN
    -- A single legacy NULL -> verified reference transition is permitted only
    -- inside the owner-executed binding RPC. Direct service-role writes fail.
    IF TG_TABLE_NAME = 'connectors' AND OLD.supabase_project_ref IS NULL AND NEW.supabase_project_ref IS NOT NULL
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(proowner) FROM pg_catalog.pg_proc
        WHERE oid = 'public.connector_bind_supabase_project(uuid,uuid,uuid,integer,text,text)'::regprocedure) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Connector project binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_guard_supabase_project_ref() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER connector_project_binding_guard BEFORE UPDATE ON public.connectors
  FOR EACH ROW EXECUTE FUNCTION public.connector_guard_supabase_project_ref();
CREATE TRIGGER connector_attempt_project_binding_guard BEFORE UPDATE ON public.site_connector_auth_attempts
  FOR EACH ROW EXECUTE FUNCTION public.connector_guard_supabase_project_ref();

-- Only the server calls this after checking the existing provider account and
-- verifying the manager-confirmed project. A caller cannot move a bound account.
CREATE FUNCTION public.connector_bind_supabase_project(p_site_id uuid, p_connector_id uuid, p_actor_id uuid,
  p_expected_revision integer, p_project_ref text, p_credential_revision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_revision integer;
BEGIN
  v_revision := public.connector_lock_for_manager(p_site_id,p_connector_id,p_actor_id,p_expected_revision);
  IF p_project_ref IS NULL OR p_project_ref !~ '^[a-z]{20}$' THEN
    RAISE EXCEPTION 'Invalid project reference' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.site_connector_providers p JOIN public.connectors c
    ON c.provider_id=p.id AND c.site_id=p.site_id AND c.provider_project_id=p.project_id
    WHERE c.id=p_connector_id AND c.site_id=p_site_id AND c.toolkit_slug='supabase'
      AND c.supabase_project_ref IS NULL AND c.provider_status='ACTIVE' AND c.enabled AND c.verified_at IS NOT NULL
      AND NOT c.revocation_pending AND p.status='active' AND p.credential_revision=p_credential_revision FOR SHARE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account cannot be bound' USING ERRCODE='40001'; END IF;
  UPDATE public.connectors SET supabase_project_ref=p_project_ref,revision=v_revision+1 WHERE id=p_connector_id AND site_id=p_site_id;
  INSERT INTO public.connector_audit_events(site_id,connector_id,actor_id,event_type,revision)
    VALUES(p_site_id,p_connector_id,p_actor_id,'provider_state_updated',v_revision+1);
  RETURN jsonb_build_object('connector_id',p_connector_id,'revision',v_revision+1);
END;
$$;
REVOKE ALL ON FUNCTION public.connector_bind_supabase_project(uuid,uuid,uuid,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.connector_bind_supabase_project(uuid,uuid,uuid,integer,text,text) TO service_role;

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
    access_mode, enabled, supabase_project_ref)
    VALUES (v_attempt.site_id, v_attempt.provider_id, v_attempt.toolkit_slug, p_provider_account_id,
      p_auth_config_id, p_display_name, 'ACTIVE', p_granted_scopes, p_actor_id, now(), 'workspace', true, v_attempt.supabase_project_ref)
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
