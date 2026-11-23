BEGIN;
SET LOCAL lock_timeout = '5s';

-- Workspace sharing is a member policy, never an agent grant. Keep existing
-- explicit rows: only connector_update_access (service role + locked manager
-- check) writes them. Neither onboarding nor this migration seeds any rows.
-- Instance direct claims and member-only account authority are unchanged.

-- Generic Support discovery, tool admission and the durable dispatch claim.
CREATE OR REPLACE FUNCTION public.connector_support_agent_account(
  p_site_id uuid, p_agent_id uuid, p_connector_id uuid, p_slug text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('connector',to_jsonb(c),'provider',to_jsonb(p),
      'policy',jsonb_build_object('revision',cp.revision,'allowed_tools',cp.allowed_tools,'allowed_hosts',cp.allowed_hosts,
        'tool_access_mode',cp.tool_access_mode,'require_approval',cp.require_approval),
      'attestation_id',b.id,'direct_revision',d.direct_revision,'resource_boundary',b.resource_boundary,
      'expires_at',b.expires_at,'local_installation_ref',b.local_installation_ref,'required_screens',r.required_screens)),
      '[]'::jsonb) INTO result
    FROM connector_result_private.direct_bindings b
    JOIN connector_result_private.direct_revisions d ON d.connector_id=b.connector_id
    JOIN connector_result_private.direct_resources r ON (r.site_id,r.resource_namespace,r.resource_boundary)=
      (b.site_id,b.resource_namespace,b.resource_boundary)
    JOIN public.sites s ON s.id=b.site_id AND s.archived_at IS NULL
    JOIN public.agents a ON (a.id,a.site_id)=(p_agent_id,s.id) AND a.status='active' AND a.role='Customer Support'
    JOIN public.connectors c ON (c.id,c.site_id)=(b.connector_id,b.site_id)
    JOIN public.site_connector_providers p ON (p.id,p.site_id)=(b.provider_id,b.site_id)
    JOIN public.connector_policies cp ON (cp.connector_id,cp.site_id)=(c.id,c.site_id)
    JOIN public.connector_agents g ON (g.agent_id,g.site_id,g.connector_id)=(a.id,c.site_id,c.id)
    WHERE b.site_id=p_site_id AND c.id=p_connector_id
      AND g.enabled AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp())
      AND 'assistant'=ANY(cp.allowed_hosts)
      AND (p_slug IS NULL OR (p_slug COLLATE "C" ~ '^[A-Z0-9][A-Z0-9_]{0,149}$'
        AND NOT starts_with(p_slug,'COMPOSIO_') AND starts_with(p_slug,upper(replace(c.toolkit_slug,'-','_')) || '_')))
      AND (cp.tool_access_mode='all' OR (cp.tool_access_mode='selected' AND CASE WHEN p_slug IS NULL THEN EXISTS (
        SELECT FROM unnest(cp.allowed_tools) slug WHERE slug COLLATE "C" ~ '^[A-Z0-9][A-Z0-9_]{0,149}$'
          AND NOT starts_with(slug,'COMPOSIO_') AND starts_with(slug,upper(replace(c.toolkit_slug,'-','_')) || '_'))
        ELSE p_slug=ANY(cp.allowed_tools) END));
  IF jsonb_array_length(result)>1 THEN RAISE EXCEPTION 'Ambiguous connector proof' USING ERRCODE='21000'; END IF;
  RETURN result;
END $$;

-- Resolve a manager-review proposal without trusting a model-supplied account.
-- Two IDs mean ambiguous: callers must not pick the first. A match is not a
-- dispatch permit. Review and execution must authorize again for their host.
CREATE INDEX connector_agents_review_candidates_idx ON public.connector_agents (site_id,agent_id,connector_id)
  WHERE enabled AND revoked_at IS NULL;
CREATE FUNCTION public.connector_agent_review_candidates(p_site_id uuid,p_agent_id uuid,p_slug text)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  IF p_slug IS NULL OR p_slug COLLATE "C" !~ '^[A-Z0-9][A-Z0-9_]{0,149}$' OR starts_with(p_slug,'COMPOSIO_') THEN RETURN; END IF;
  RETURN QUERY SELECT g.connector_id FROM public.connector_agents g
    JOIN public.connectors c ON (c.site_id,c.id)=(g.site_id,g.connector_id)
    JOIN public.connector_policies cp ON (cp.site_id,cp.connector_id)=(g.site_id,g.connector_id)
    WHERE (g.site_id,g.agent_id)=(p_site_id,p_agent_id) AND g.enabled AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp()) AND cp.require_approval
      AND starts_with(p_slug,upper(replace(c.toolkit_slug,'-','_')) || '_')
      AND jsonb_array_length(public.connector_support_agent_account(p_site_id,p_agent_id,g.connector_id,p_slug))=1
    ORDER BY g.connector_id LIMIT 2;
END $$;
REVOKE ALL ON FUNCTION public.connector_agent_review_candidates(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_agent_review_candidates(uuid,uuid,text) TO service_role;

-- The legacy channel publication index must not imply an agent grant either.
CREATE OR REPLACE FUNCTION public.connector_support_publication_page(
  p_site_id uuid, p_agent_id uuid, p_audience text, p_after uuid DEFAULT NULL, p_exact uuid DEFAULT NULL
) RETURNS TABLE(connector_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT p.connector_id FROM public.connector_policies p
  JOIN public.sites s ON s.id = p.site_id AND s.archived_at IS NULL
  JOIN public.agents a ON a.id = p_agent_id AND a.site_id = p.site_id AND a.status = 'active'
  JOIN public.connectors c ON c.id = p.connector_id AND c.site_id = p.site_id
  JOIN public.site_connector_providers v ON v.id = c.provider_id AND v.site_id = c.site_id AND v.status = 'active'
  JOIN public.connector_agents g ON g.site_id = p.site_id AND g.connector_id = c.id AND g.agent_id = a.id
  WHERE p.site_id = p_site_id AND (p_after IS NULL OR p.connector_id > p_after)
    AND (p_exact IS NULL OR p.connector_id = p_exact)
    AND p_audience IN ('anonymous','verified') AND p.support_publication->>'audience' IN ('anonymous',p_audience)
    AND 'assistant' = ANY(p.allowed_hosts) AND (p.tool_access_mode = 'all' OR 'GMAIL_FETCH_EMAILS' = ANY(p.allowed_tools))
    AND c.toolkit_slug = 'gmail' AND c.enabled AND c.provider_status = 'ACTIVE' AND NOT c.revocation_pending
    AND c.verified_at IS NOT NULL AND 'https://www.googleapis.com/auth/gmail.readonly' = ANY(c.granted_scopes)
    AND g.enabled AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > statement_timestamp())
  ORDER BY p.connector_id LIMIT 6;
$$;

-- Reviewed/private receipts retain the member AND agent intersection,
-- policy revisions and current credential checks on both write and reread.
CREATE OR REPLACE FUNCTION connector_result_private.admitted(
  p_site_id uuid, p_user_id uuid, p_instance_id uuid, p_agent_id uuid, p_connector_id uuid,
  p_tool text, p_catalog boolean, p_connector_revision integer, p_policy_revision integer, p_credential_revision text
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.site_user_has_effective_access(p_site_id,p_user_id)
    AND public.connector_catalog_read_actor(p_site_id,p_user_id,p_instance_id,p_agent_id) AND EXISTS (
    SELECT 1 FROM public.connectors c
    JOIN public.site_connector_providers p ON (p.id,p.site_id,p.project_id) = (c.provider_id,c.site_id,c.provider_project_id)
    JOIN public.connector_policies policy ON (policy.site_id,policy.connector_id) = (c.site_id,c.id)
    LEFT JOIN public.connector_members m ON (m.site_id,m.connector_id,m.user_id) = (c.site_id,c.id,p_user_id)
    JOIN public.connector_agents a ON (a.site_id,a.connector_id,a.agent_id) = (c.site_id,c.id,p_agent_id)
    WHERE (c.id,c.site_id) = (p_connector_id,p_site_id) AND c.enabled AND c.verified_at IS NOT NULL
      AND NOT c.revocation_pending AND NOT c.revocation_dispatched AND c.provider_status = 'ACTIVE'
      AND p.status = 'active' AND p.credential_revision = p_credential_revision
      AND (p.credential_revision COLLATE "C" ~ '^platform:[a-f0-9]{64}$' OR EXISTS (
        SELECT 1 FROM connector_result_private.provider_attestations proof
        WHERE (proof.site_id,proof.credential_revision,proof.project_id) = (p.site_id,p.credential_revision,p.project_id)))
      AND c.revision = p_connector_revision AND policy.revision = p_policy_revision
      AND 'assistant' = ANY(policy.allowed_hosts) AND (policy.tool_access_mode = 'all' OR p_tool = ANY(policy.allowed_tools))
      AND (CASE WHEN p_catalog THEN policy.catalog_reads ELSE p_tool IN ('GMAIL_FETCH_EMAILS','HUBSPOT_LIST_CONTACTS','SUPABASE_LIST_TABLES') END)
      AND (CASE WHEN m.user_id IS NULL THEN c.access_mode = 'workspace' ELSE m.can_view AND m.can_use
        AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp()) END)
      AND (a.enabled
        AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > statement_timestamp()))
  );
$$;

-- CREATE OR REPLACE retains function identities, owners and execute ACLs.
COMMIT;
