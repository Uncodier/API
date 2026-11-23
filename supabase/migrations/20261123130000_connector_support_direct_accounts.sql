BEGIN;
SET LOCAL lock_timeout = '5s';

-- Agent authority only. The caller must independently verify the request host,
-- audience, turn, action scope and any entitlement to receive provider data.
CREATE FUNCTION public.connector_support_agent_account(
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
    LEFT JOIN public.connector_agents g ON (g.agent_id,g.site_id,g.connector_id)=(a.id,c.site_id,c.id)
    WHERE b.site_id=p_site_id AND c.id=p_connector_id
      AND CASE WHEN g.agent_id IS NULL THEN c.access_mode='workspace'
        ELSE g.enabled AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp()) END
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

-- A claim burns one tool call for a verified turn even on provider failure.
-- Pin, args, result and message content are neither stored nor part of the key.
CREATE TABLE connector_result_private.support_dispatch_claims (
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  turn_digest text COLLATE "C" NOT NULL CHECK (turn_digest ~ '^[0-9a-f]{64}$'),
  connector_id uuid NOT NULL, slug text COLLATE "C" NOT NULL,
  PRIMARY KEY (site_id,conversation_id,turn_digest,connector_id,slug)
);
CREATE INDEX support_dispatch_conversation_idx ON connector_result_private.support_dispatch_claims(conversation_id);
ALTER TABLE connector_result_private.support_dispatch_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.support_dispatch_claims FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

CREATE FUNCTION public.connector_claim_support_dispatch(
  p_site_id uuid,p_agent_id uuid,p_user_id uuid,p_conversation_id uuid,p_connector_id uuid,p_slug text,p_turn_digest text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  INSERT INTO connector_result_private.support_dispatch_claims(site_id,conversation_id,turn_digest,connector_id,slug)
    SELECT p_site_id,p_conversation_id,p_turn_digest,p_connector_id,p_slug FROM public.conversations t
    WHERE (t.id,t.site_id,t.agent_id,t.user_id)=(p_conversation_id,p_site_id,p_agent_id,p_user_id)
      AND p_turn_digest COLLATE "C" ~ '^[0-9a-f]{64}$' AND p_connector_id IS NOT NULL AND p_slug IS NOT NULL
      AND jsonb_array_length(public.connector_support_agent_account(p_site_id,p_agent_id,p_connector_id,p_slug))=1
    ON CONFLICT DO NOTHING;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.connector_support_agent_account(uuid,uuid,uuid,text),
  public.connector_claim_support_dispatch(uuid,uuid,uuid,uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_support_agent_account(uuid,uuid,uuid,text),
  public.connector_claim_support_dispatch(uuid,uuid,uuid,uuid,uuid,text,text) TO service_role;
COMMIT;