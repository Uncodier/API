BEGIN;
SET LOCAL lock_timeout = '5s';

-- Operator-reviewed Composio BYOK project + callback proof, never a key or a use grant.
-- No seed/backfill, wildcard, actor-facing write API or changes to existing connections.
CREATE TABLE connector_result_private.provider_attestations (
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  credential_revision text COLLATE "C" NOT NULL CHECK (credential_revision ~ '^[a-f0-9]{64}$'),
  project_id text COLLATE "C" NOT NULL CHECK (project_id ~ '^[a-zA-Z0-9_-]{1,200}$'),
  oauth_verifier_url text COLLATE "C" NOT NULL CHECK (octet_length(oauth_verifier_url) <= 2048
    AND oauth_verifier_url ~ '^https://([a-z0-9.-]+|\[[0-9a-f:]+\])(:[0-9]{1,5})?/connectors/callback$'),
  PRIMARY KEY (site_id, credential_revision)
);
ALTER TABLE connector_result_private.provider_attestations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.provider_attestations FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

-- No table/list access: an already authorized server operation supplies all three
-- values. The revision is SHA-256 of the stored ciphertext, never the raw key.
CREATE FUNCTION public.connector_attested_provider_project(p_site_id uuid, p_credential_revision text, p_oauth_verifier_url text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.project_id FROM connector_result_private.provider_attestations a
  WHERE current_setting('role', true) = 'service_role'
    AND (a.site_id,a.credential_revision,a.oauth_verifier_url) = (p_site_id,p_credential_revision,p_oauth_verifier_url);
$$;
REVOKE ALL ON FUNCTION public.connector_attested_provider_project(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_attested_provider_project(uuid,text,text) TO service_role;

-- Readiness, storage and subsequent owner-only receipt reads must not outlive a
-- withdrawn BYOK proof. Preserve all existing grant, revision and RLS checks.
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
    LEFT JOIN public.connector_agents a ON (a.site_id,a.connector_id,a.agent_id) = (c.site_id,c.id,p_agent_id)
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
      AND (CASE WHEN a.agent_id IS NULL THEN c.access_mode = 'workspace' ELSE a.enabled
        AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > statement_timestamp()) END)
  );
$$;

COMMIT;