BEGIN;
SET LOCAL lock_timeout = '5s';

-- NULL (including every existing policy and every new OAuth connection) is unpublished.
-- This single audited action exposes only subjects from a fixed custom Gmail label.
ALTER TABLE public.connector_policies ADD COLUMN support_publication jsonb
  CHECK (support_publication IS NULL OR (
    jsonb_typeof(support_publication) = 'object'
    AND support_publication ?& ARRAY['audience','label_id']
    AND support_publication - 'audience' - 'label_id' = '{}'::jsonb
    AND support_publication->>'audience' IN ('anonymous','verified')
    AND jsonb_typeof(support_publication->'label_id') = 'string'
    AND support_publication->>'label_id' ~ '^Label_[0-9]{1,32}$'
  ) IS TRUE);

-- Exclude unpublished accounts before the bounded keyset scan.
CREATE INDEX connector_support_publication_page ON public.connector_policies (site_id, connector_id)
  WHERE support_publication->>'audience' IS NOT NULL;

-- The existing manager-only read policy still applies. Writes are performed only
-- through the serialized manager RPC; old clients omit the publication and clear it.
DROP FUNCTION public.connector_update_policy(uuid, uuid, uuid, integer, text[], text[], boolean, boolean, text);
CREATE FUNCTION public.connector_update_policy(
  p_site_id uuid, p_connector_id uuid, p_actor_id uuid, p_expected_revision integer,
  p_allowed_tools text[], p_allowed_hosts text[], p_require_approval boolean,
  p_enabled boolean DEFAULT NULL, p_tool_access_mode text DEFAULT 'selected',
  p_support_publication jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_revision integer; v_policy_revision integer;
BEGIN
  v_revision := public.connector_lock_for_manager(p_site_id, p_connector_id, p_actor_id, p_expected_revision);
  IF public.connector_valid_text_array(p_allowed_tools, 200, '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$') IS NOT TRUE
    OR public.connector_valid_text_array(p_allowed_hosts, 2, '^(assistant|direct)$') IS NOT TRUE
    OR p_require_approval IS NULL OR p_tool_access_mode IS NULL OR p_tool_access_mode NOT IN ('selected', 'all') THEN
    RAISE EXCEPTION 'Invalid connector policy' USING ERRCODE = '22023';
  END IF;
  IF p_support_publication IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.connectors c WHERE c.id = p_connector_id AND c.site_id = p_site_id AND c.toolkit_slug = 'gmail'
  ) THEN RAISE EXCEPTION 'Unsupported publication toolkit' USING ERRCODE = '22023'; END IF;
  IF p_enabled IS TRUE AND NOT EXISTS (
    SELECT 1 FROM public.connectors c JOIN public.site_connector_providers p
      ON p.id = c.provider_id AND p.site_id = c.site_id
    WHERE c.id = p_connector_id AND c.site_id = p_site_id AND c.provider_status = 'ACTIVE'
      AND c.verified_at IS NOT NULL AND NOT c.revocation_pending AND p.status = 'active'
  ) THEN RAISE EXCEPTION 'Connector is not ready' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.connector_policies(site_id, connector_id, allowed_tools, allowed_hosts, require_approval, tool_access_mode, support_publication)
    VALUES (p_site_id, p_connector_id, p_allowed_tools, p_allowed_hosts, p_require_approval, p_tool_access_mode, p_support_publication)
    ON CONFLICT (connector_id) DO UPDATE SET allowed_tools = EXCLUDED.allowed_tools,
      allowed_hosts = EXCLUDED.allowed_hosts, require_approval = EXCLUDED.require_approval,
      tool_access_mode = EXCLUDED.tool_access_mode,
      support_publication = EXCLUDED.support_publication,
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
REVOKE ALL ON FUNCTION public.connector_update_policy(uuid, uuid, uuid, integer, text[], text[], boolean, boolean, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_update_policy(uuid, uuid, uuid, integer, text[], text[], boolean, boolean, text, jsonb)
  TO service_role;

-- Discovery only, never a capability to execute. The runtime rechecks exact
-- authorization, current credentials and provider descriptor before dispatch.
CREATE FUNCTION public.connector_support_publication_page(
  p_site_id uuid, p_agent_id uuid, p_audience text, p_after uuid DEFAULT NULL, p_exact uuid DEFAULT NULL
) RETURNS TABLE(connector_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT p.connector_id FROM public.connector_policies p
  JOIN public.sites s ON s.id = p.site_id AND s.archived_at IS NULL
  JOIN public.agents a ON a.id = p_agent_id AND a.site_id = p.site_id AND a.status = 'active'
  JOIN public.connectors c ON c.id = p.connector_id AND c.site_id = p.site_id
  JOIN public.site_connector_providers v ON v.id = c.provider_id AND v.site_id = c.site_id AND v.status = 'active'
  LEFT JOIN public.connector_agents g ON g.site_id = p.site_id AND g.connector_id = c.id AND g.agent_id = a.id
  WHERE p.site_id = p_site_id AND (p_after IS NULL OR p.connector_id > p_after)
    AND (p_exact IS NULL OR p.connector_id = p_exact)
    AND p_audience IN ('anonymous','verified') AND p.support_publication->>'audience' IN ('anonymous',p_audience)
    AND 'assistant' = ANY(p.allowed_hosts) AND (p.tool_access_mode = 'all' OR 'GMAIL_FETCH_EMAILS' = ANY(p.allowed_tools))
    AND c.toolkit_slug = 'gmail' AND c.enabled AND c.provider_status = 'ACTIVE' AND NOT c.revocation_pending
    AND c.verified_at IS NOT NULL AND 'https://www.googleapis.com/auth/gmail.readonly' = ANY(c.granted_scopes)
    AND CASE WHEN g.agent_id IS NULL THEN c.access_mode = 'workspace'
      ELSE g.enabled AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > statement_timestamp()) END
  ORDER BY p.connector_id LIMIT 6;
$$;
REVOKE ALL ON FUNCTION public.connector_support_publication_page(uuid,uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_support_publication_page(uuid,uuid,text,uuid,uuid) TO service_role;

COMMIT;
