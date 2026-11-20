BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.connector_lock_for_manager(
  p_site_id uuid, p_connector_id uuid, p_actor_id uuid, p_expected_revision integer
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_revision integer;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Connector service role required' USING ERRCODE = '42501';
  END IF;
  SELECT c.revision INTO v_revision FROM public.connectors c
    WHERE c.id = p_connector_id AND c.site_id = p_site_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.connector_effective_site_access(p_site_id, p_actor_id) a
    WHERE a.can_manage) THEN RAISE EXCEPTION 'Connector management denied' USING ERRCODE = '42501'; END IF;
  IF p_expected_revision IS NULL OR p_expected_revision <> v_revision THEN
    RAISE EXCEPTION 'Connector revision conflict' USING ERRCODE = '40001';
  END IF;
  RETURN v_revision;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_lock_for_manager(uuid, uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.connector_update_access(
  p_site_id uuid, p_connector_id uuid, p_actor_id uuid, p_expected_revision integer,
  p_members jsonb, p_agents jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_item jsonb; v_id uuid; v_seen uuid[]; v_expires timestamptz; v_revoked timestamptz;
  v_view boolean; v_use boolean; v_enabled boolean; v_revision integer;
BEGIN
  v_revision := public.connector_lock_for_manager(p_site_id, p_connector_id, p_actor_id, p_expected_revision);
  IF jsonb_typeof(p_members) IS DISTINCT FROM 'array' OR jsonb_typeof(p_agents) IS DISTINCT FROM 'array'
    OR octet_length(p_members::text) + octet_length(p_agents::text) > 65536 THEN
    RAISE EXCEPTION 'Invalid connector grant patch' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_members) > 100 OR jsonb_array_length(p_agents) > 100
    OR jsonb_array_length(p_members) + jsonb_array_length(p_agents) = 0 THEN
    RAISE EXCEPTION 'Invalid connector grant patch size' USING ERRCODE = '22023';
  END IF;
  v_seen := '{}';
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_members) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
      OR v_item - ARRAY['user_id','can_view','can_use','expires_at','revoked_at'] <> '{}'::jsonb
      OR jsonb_typeof(v_item->'user_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'can_view') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(v_item->'can_use') IS DISTINCT FROM 'boolean'
      OR (v_item ? 'expires_at' AND jsonb_typeof(v_item->'expires_at') NOT IN ('string','null'))
      OR (v_item ? 'revoked_at' AND jsonb_typeof(v_item->'revoked_at') NOT IN ('string','null')) THEN
      RAISE EXCEPTION 'Invalid connector member patch' USING ERRCODE = '22023';
    END IF;
    v_id := (v_item->>'user_id')::uuid;
    IF v_id = ANY(v_seen) THEN RAISE EXCEPTION 'Duplicate connector member' USING ERRCODE = '22023'; END IF;
    v_seen := array_append(v_seen, v_id);
    v_view := (v_item->>'can_view')::boolean; v_use := (v_item->>'can_use')::boolean;
    v_expires := (v_item->>'expires_at')::timestamptz; v_revoked := (v_item->>'revoked_at')::timestamptz;
    IF (v_use AND NOT v_view) OR (v_expires IS NOT NULL AND NOT isfinite(v_expires))
      OR (v_revoked IS NOT NULL AND (NOT isfinite(v_revoked) OR v_revoked > clock_timestamp())) THEN
      RAISE EXCEPTION 'Invalid connector member grant' USING ERRCODE = '22023';
    END IF;
    -- Update first: a retained grant can be revoked after site membership removal.
    UPDATE public.connector_members SET can_view = v_view, can_use = v_use,
      expires_at = v_expires, revoked_at = v_revoked, granted_by = p_actor_id, updated_at = now()
      WHERE site_id = p_site_id AND connector_id = p_connector_id AND user_id = v_id;
    IF NOT FOUND THEN
      INSERT INTO public.connector_members(site_id, connector_id, user_id, can_view, can_use,
        expires_at, revoked_at, granted_by)
        VALUES (p_site_id, p_connector_id, v_id, v_view, v_use, v_expires, v_revoked, p_actor_id);
    END IF;
  END LOOP;
  v_seen := '{}';
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_agents) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
      OR v_item - ARRAY['agent_id','enabled','expires_at','revoked_at'] <> '{}'::jsonb
      OR jsonb_typeof(v_item->'agent_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'enabled') IS DISTINCT FROM 'boolean'
      OR (v_item ? 'expires_at' AND jsonb_typeof(v_item->'expires_at') NOT IN ('string','null'))
      OR (v_item ? 'revoked_at' AND jsonb_typeof(v_item->'revoked_at') NOT IN ('string','null')) THEN
      RAISE EXCEPTION 'Invalid connector agent patch' USING ERRCODE = '22023';
    END IF;
    v_id := (v_item->>'agent_id')::uuid;
    IF v_id = ANY(v_seen) THEN RAISE EXCEPTION 'Duplicate connector agent' USING ERRCODE = '22023'; END IF;
    v_seen := array_append(v_seen, v_id);
    v_enabled := (v_item->>'enabled')::boolean;
    v_expires := (v_item->>'expires_at')::timestamptz; v_revoked := (v_item->>'revoked_at')::timestamptz;
    IF (v_expires IS NOT NULL AND NOT isfinite(v_expires))
      OR (v_revoked IS NOT NULL AND (NOT isfinite(v_revoked) OR v_revoked > clock_timestamp())) THEN
      RAISE EXCEPTION 'Invalid connector agent grant' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.agents a WHERE a.id = v_id AND a.site_id = p_site_id
      AND (NOT v_enabled OR v_revoked IS NOT NULL OR a.status = 'active')) THEN
      RAISE EXCEPTION 'Connector agent target denied' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.connector_agents(site_id, connector_id, agent_id, enabled,
      expires_at, revoked_at, granted_by)
      VALUES (p_site_id, p_connector_id, v_id, v_enabled, v_expires, v_revoked, p_actor_id)
      ON CONFLICT (connector_id, agent_id) DO UPDATE SET enabled = EXCLUDED.enabled,
        expires_at = EXCLUDED.expires_at, revoked_at = EXCLUDED.revoked_at,
        granted_by = EXCLUDED.granted_by, updated_at = now();
  END LOOP;
  UPDATE public.connectors SET revision = v_revision + 1, updated_at = now()
    WHERE id = p_connector_id AND site_id = p_site_id;
  INSERT INTO public.connector_audit_events(site_id, connector_id, actor_id, event_type, revision)
    VALUES (p_site_id, p_connector_id, p_actor_id, 'access_updated', v_revision + 1);
  RETURN jsonb_build_object('connector_id', p_connector_id, 'revision', v_revision + 1);
END;
$$;
REVOKE ALL ON FUNCTION public.connector_update_access(uuid, uuid, uuid, integer, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_update_access(uuid, uuid, uuid, integer, jsonb, jsonb) TO service_role;

CREATE FUNCTION public.connector_update_policy(
  p_site_id uuid, p_connector_id uuid, p_actor_id uuid, p_expected_revision integer,
  p_allowed_tools text[], p_allowed_hosts text[], p_require_approval boolean,
  p_enabled boolean DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_revision integer; v_policy_revision integer;
BEGIN
  v_revision := public.connector_lock_for_manager(p_site_id, p_connector_id, p_actor_id, p_expected_revision);
  IF public.connector_valid_text_array(p_allowed_tools, 200, '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$') IS NOT TRUE
    OR public.connector_valid_text_array(p_allowed_hosts, 2, '^(assistant|direct)$') IS NOT TRUE
    OR p_require_approval IS NULL THEN
    RAISE EXCEPTION 'Invalid connector policy' USING ERRCODE = '22023';
  END IF;
  IF p_enabled IS TRUE AND NOT EXISTS (
    SELECT 1 FROM public.connectors c JOIN public.site_connector_providers p
      ON p.id = c.provider_id AND p.site_id = c.site_id
    WHERE c.id = p_connector_id AND c.site_id = p_site_id AND c.provider_status = 'ACTIVE'
      AND c.verified_at IS NOT NULL AND NOT c.revocation_pending AND p.status = 'active'
  ) THEN RAISE EXCEPTION 'Connector is not ready' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.connector_policies(site_id, connector_id, allowed_tools, allowed_hosts, require_approval)
    VALUES (p_site_id, p_connector_id, p_allowed_tools, p_allowed_hosts, p_require_approval)
    ON CONFLICT (connector_id) DO UPDATE SET allowed_tools = EXCLUDED.allowed_tools,
      allowed_hosts = EXCLUDED.allowed_hosts, require_approval = EXCLUDED.require_approval,
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
REVOKE ALL ON FUNCTION public.connector_update_policy(uuid, uuid, uuid, integer, text[], text[], boolean, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_update_policy(uuid, uuid, uuid, integer, text[], text[], boolean, boolean)
  TO service_role;

COMMIT;