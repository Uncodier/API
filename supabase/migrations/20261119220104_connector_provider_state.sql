BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.connector_audit_events DROP CONSTRAINT connector_audit_events_event_type_check;
ALTER TABLE public.connector_audit_events ADD CONSTRAINT connector_audit_events_event_type_check
  CHECK (event_type IN ('access_updated','policy_updated','auth_completed','provider_state_updated'));

-- Called after provider verification, or before a remote revoke to block local use.
-- The caller never supplies account identity, grants or an enabled=true flag.
CREATE FUNCTION public.connector_set_provider_state(
  p_site_id uuid, p_connector_id uuid, p_actor_id uuid, p_expected_revision integer,
  p_provider_status text, p_revocation_pending boolean, p_verified boolean,
  p_granted_scopes text[] DEFAULT NULL, p_credential_revision text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_revision integer; v_connector public.connectors%ROWTYPE;
BEGIN
  v_revision := public.connector_lock_for_manager(p_site_id, p_connector_id, p_actor_id, p_expected_revision);
  IF p_provider_status IS NULL OR p_provider_status !~ '^[A-Z_]{1,40}$'
    OR p_revocation_pending IS NULL OR p_verified IS NULL THEN
    RAISE EXCEPTION 'Invalid connector provider state' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_connector FROM public.connectors WHERE id = p_connector_id AND site_id = p_site_id;
  IF p_granted_scopes IS NOT NULL AND public.connector_valid_text_array(p_granted_scopes, 200, '^.{1,255}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid connector granted scopes' USING ERRCODE = '22023';
  END IF;
  IF p_verified AND (p_credential_revision IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.site_connector_providers p WHERE p.id = v_connector.provider_id
      AND p.site_id = p_site_id AND p.status = 'active' AND p.credential_revision = p_credential_revision
  )) THEN RAISE EXCEPTION 'Connector provider credentials changed' USING ERRCODE = '40001'; END IF;
  -- A stale sync cannot cancel a revocation request or reactivate an account.
  IF v_connector.revocation_pending AND NOT p_revocation_pending
    AND (p_provider_status <> 'REVOKED' OR NOT p_verified) THEN
    RAISE EXCEPTION 'Connector revocation is not confirmed' USING ERRCODE = '22023';
  END IF;
  IF v_connector.provider_status = 'REVOKED' AND p_provider_status <> 'REVOKED' THEN
    RAISE EXCEPTION 'Revoked connector cannot be restored' USING ERRCODE = '22023';
  END IF;
  UPDATE public.connectors SET provider_status = p_provider_status,
    revocation_pending = p_revocation_pending,
    enabled = enabled AND p_provider_status = 'ACTIVE' AND NOT p_revocation_pending AND p_verified,
    granted_scopes = coalesce(p_granted_scopes, granted_scopes),
    verified_at = CASE WHEN p_verified THEN clock_timestamp() ELSE NULL END,
    revision = v_revision + 1, updated_at = now()
    WHERE id = p_connector_id AND site_id = p_site_id
    RETURNING * INTO v_connector;
  INSERT INTO public.connector_audit_events(site_id,connector_id,actor_id,event_type,revision)
    VALUES (p_site_id,p_connector_id,p_actor_id,'provider_state_updated',v_revision+1);
  RETURN to_jsonb(v_connector);
END;
$$;
REVOKE ALL ON FUNCTION public.connector_set_provider_state(uuid,uuid,uuid,integer,text,boolean,boolean,text[],text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_set_provider_state(uuid,uuid,uuid,integer,text,boolean,boolean,text[],text)
  TO service_role;

CREATE FUNCTION public.connector_access_options(p_site_id uuid, p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_members jsonb; v_agents jsonb;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' OR NOT EXISTS (
    SELECT 1 FROM public.connector_effective_site_access(p_site_id, p_actor_id) a WHERE a.can_manage
  ) THEN RAISE EXCEPTION 'Connector management denied' USING ERRCODE = '42501'; END IF;
  WITH candidates AS (
    SELECT s.user_id AS id, 'Workspace owner'::text AS label FROM public.sites s WHERE s.id = p_site_id
    UNION SELECT o.user_id, 'Workspace co-owner' FROM public.site_ownership o WHERE o.site_id = p_site_id
    UNION SELECT m.user_id, coalesce(nullif(to_jsonb(m)->>'name',''), 'Workspace member')
      FROM public.site_members m WHERE m.site_id = p_site_id AND m.user_id IS NOT NULL
  ), eligible AS (
    SELECT DISTINCT ON (c.id) c.id, c.label FROM candidates c
      CROSS JOIN LATERAL public.connector_effective_site_access(p_site_id, c.id) a
      WHERE a.can_view ORDER BY c.id, c.label LIMIT 1001
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label)), '[]') INTO v_members FROM eligible;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'label',coalesce(nullif(to_jsonb(a)->>'name',''), 'Agent'))), '[]')
    INTO v_agents FROM (SELECT * FROM public.agents WHERE site_id = p_site_id AND status = 'active' ORDER BY id LIMIT 1001) a;
  IF jsonb_array_length(v_members) > 1000 OR jsonb_array_length(v_agents) > 1000 THEN
    RAISE EXCEPTION 'Connector access options exceed limit' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('member_options',v_members,'agent_options',v_agents);
END;
$$;
REVOKE ALL ON FUNCTION public.connector_access_options(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_access_options(uuid,uuid) TO service_role;

COMMIT;