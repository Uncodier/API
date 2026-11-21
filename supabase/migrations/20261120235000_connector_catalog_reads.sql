BEGIN;
SET LOCAL lock_timeout = '5s';

-- Neither an existing selection nor an OAuth policy seeded in 'all' mode is consent.
ALTER TABLE public.connector_policies ADD COLUMN catalog_reads boolean NOT NULL DEFAULT false;

-- Local opt-out cannot depend on provider availability, a valid OAuth grant or a
-- still-listed tool. This signature has no fields that could expand authority.
CREATE FUNCTION public.connector_disable_catalog_reads(
  p_site_id uuid, p_connector_id uuid, p_actor_id uuid, p_expected_revision integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_revision integer; v_policy_revision integer;
BEGIN
  v_revision := public.connector_lock_for_manager(p_site_id, p_connector_id, p_actor_id, p_expected_revision);
  UPDATE public.connector_policies SET catalog_reads = false, revision = revision + 1, updated_at = now()
    WHERE site_id = p_site_id AND connector_id = p_connector_id RETURNING revision INTO v_policy_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Connector policy unavailable' USING ERRCODE = '22023'; END IF;
  UPDATE public.connectors SET revision = v_revision + 1, updated_at = now()
    WHERE site_id = p_site_id AND id = p_connector_id;
  INSERT INTO public.connector_audit_events(site_id, connector_id, actor_id, event_type, revision)
    VALUES (p_site_id, p_connector_id, p_actor_id, 'policy_updated', v_revision + 1);
  RETURN jsonb_build_object('connector_id', p_connector_id, 'revision', v_revision + 1, 'policy_revision', v_policy_revision);
END;
$$;
REVOKE ALL ON FUNCTION public.connector_disable_catalog_reads(uuid,uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_disable_catalog_reads(uuid,uuid,uuid,integer) TO service_role;

-- Keep the existing signature (including its trailing defaults) for older clients.
-- Its upsert does not touch catalog_reads. This overload has no defaults: exactly
-- one signature matches each request, including PostgREST calls using named args.
CREATE FUNCTION public.connector_update_policy(
  p_site_id uuid, p_connector_id uuid, p_actor_id uuid, p_expected_revision integer,
  p_allowed_tools text[], p_allowed_hosts text[], p_require_approval boolean, p_enabled boolean,
  p_tool_access_mode text, p_support_publication jsonb, p_catalog_reads boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE receipt jsonb;
BEGIN
  IF p_catalog_reads IS FALSE THEN
    -- Full-policy editors may still submit stale, delisted IDs. Only skip
    -- provider validation for an opt-out that changes no other policy fields.
    PERFORM public.connector_lock_for_manager(p_site_id, p_connector_id, p_actor_id, p_expected_revision);
    IF NOT EXISTS (SELECT 1 FROM public.connector_policies cp JOIN public.connectors c
      ON c.site_id = cp.site_id AND c.id = cp.connector_id
      WHERE cp.site_id = p_site_id AND cp.connector_id = p_connector_id
        AND (p_enabled IS NULL OR p_enabled = c.enabled) AND p_tool_access_mode = cp.tool_access_mode
        AND p_allowed_tools = cp.allowed_tools AND p_allowed_hosts = cp.allowed_hosts
        AND p_require_approval = cp.require_approval AND p_support_publication IS NOT DISTINCT FROM cp.support_publication
    ) THEN RAISE EXCEPTION 'Save catalog opt-out separately' USING ERRCODE = 'P0C01'; END IF;
    RETURN public.connector_disable_catalog_reads(p_site_id, p_connector_id, p_actor_id, p_expected_revision);
  END IF;
  -- Same manager and revision lock, validation, single revision and audit event
  -- as a legacy save. The lock is held until this transaction ends.
  receipt := public.connector_update_policy(p_site_id, p_connector_id, p_actor_id, p_expected_revision,
    p_allowed_tools, p_allowed_hosts, p_require_approval, p_enabled, p_tool_access_mode, p_support_publication);
  IF p_catalog_reads IS NULL THEN
    RAISE EXCEPTION 'Invalid catalog reads setting' USING ERRCODE = '22023';
  END IF;
  IF p_catalog_reads AND (NOT ('assistant' = ANY(p_allowed_hosts)) OR NOT EXISTS (
    SELECT 1 FROM public.connectors c JOIN public.site_connector_providers p
      ON p.id = c.provider_id AND p.site_id = c.site_id
    WHERE c.id = p_connector_id AND c.site_id = p_site_id AND c.enabled AND c.verified_at IS NOT NULL
      AND c.provider_status = 'ACTIVE' AND NOT c.revocation_pending AND NOT c.revocation_dispatched AND p.status = 'active'
  )) THEN RAISE EXCEPTION 'Connector is not ready for instance catalog reads' USING ERRCODE = '22023'; END IF;
  UPDATE public.connector_policies SET catalog_reads = p_catalog_reads
    WHERE connector_id = p_connector_id AND site_id = p_site_id;
  RETURN receipt;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_update_policy(uuid,uuid,uuid,integer,text[],text[],boolean,boolean,text,jsonb,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_update_policy(uuid,uuid,uuid,integer,text[],text[],boolean,boolean,text,jsonb,boolean)
  TO service_role;

-- Provider reads cannot enforce workspace row assignments. Recheck the verified
-- instance owner, site and active prompt agent and require site-wide access.
-- This predicate does not confer connector use or select an agent.
CREATE FUNCTION public.connector_catalog_read_actor(p_site_id uuid, p_user_id uuid, p_instance_id uuid, p_agent_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.connector_site_access(p_site_id, p_user_id) access
    JOIN public.sites s ON s.id = p_site_id AND s.archived_at IS NULL
    JOIN public.remote_instances i ON i.id = p_instance_id AND i.site_id = s.id AND i.user_id = p_user_id AND i.is_archived IS FALSE
    JOIN public.agents a ON a.id = p_agent_id AND a.site_id = s.id AND a.status = 'active'
    WHERE access.can_view AND (s.user_id = p_user_id OR EXISTS (
      SELECT 1 FROM public.site_ownership o WHERE o.site_id = s.id AND o.user_id = p_user_id
    ) OR EXISTS (
      SELECT 1 FROM public.site_members m WHERE m.site_id = s.id AND m.user_id = p_user_id
        AND m.status = 'active' AND m.restrict_to_assigned_only IS FALSE AND cardinality(m.blocked_screens) = 0
        AND NOT EXISTS (SELECT 1 FROM public.site_member_location_restrictions r
          WHERE r.site_id = s.id AND r.site_member_id = m.id)
    ))
  );
$$;
REVOKE ALL ON FUNCTION public.connector_catalog_read_actor(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_catalog_read_actor(uuid,uuid,uuid,uuid) TO service_role;

COMMIT;