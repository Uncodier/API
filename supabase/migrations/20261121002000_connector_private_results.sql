BEGIN;
SET LOCAL lock_timeout = '5s';

-- Deliberately outside the Data API, instance history, conversations and realtime.
-- Even the service role cannot SELECT this table or invoke the user-facing read.
CREATE SCHEMA connector_result_private;
REVOKE ALL ON SCHEMA connector_result_private FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE connector_result_private.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  tool text NOT NULL CHECK (tool ~ '^[A-Z0-9][A-Z0-9_]{0,149}$'),
  catalog boolean NOT NULL,
  version text NOT NULL CHECK (version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  schema_hash text NOT NULL CHECK (schema_hash ~ '^[a-f0-9]{64}$'),
  connector_revision integer NOT NULL,
  policy_revision integer NOT NULL,
  credential_revision text NOT NULL,
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object' AND octet_length(report::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '1 hour'),
  FOREIGN KEY (agent_id,site_id) REFERENCES public.agents(id,site_id) ON DELETE CASCADE,
  FOREIGN KEY (connector_id,site_id) REFERENCES public.connectors(id,site_id) ON DELETE CASCADE
);
CREATE INDEX ON connector_result_private.reports (owner_id, created_at DESC, id);
CREATE INDEX ON connector_result_private.reports (expires_at);
ALTER TABLE connector_result_private.reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.reports FROM PUBLIC, anon, authenticated, service_role;

-- The caller has independently verified the human session and current descriptor/dispatch.
-- Authorization here is local and fresh: an old receipt is not an access grant. Even a
-- manager cannot substitute for an absent/expired member or prompt-agent use grant.
CREATE FUNCTION connector_result_private.admitted(
  p_site_id uuid, p_user_id uuid, p_instance_id uuid, p_agent_id uuid, p_connector_id uuid,
  p_tool text, p_catalog boolean, p_connector_revision integer, p_policy_revision integer, p_credential_revision text
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
      AND c.revision = p_connector_revision AND policy.revision = p_policy_revision
      AND 'assistant' = ANY(policy.allowed_hosts) AND (policy.tool_access_mode = 'all' OR p_tool = ANY(policy.allowed_tools))
      AND (CASE WHEN p_catalog THEN policy.catalog_reads ELSE p_tool IN ('GMAIL_FETCH_EMAILS','HUBSPOT_LIST_CONTACTS','SUPABASE_LIST_TABLES') END)
      AND (CASE WHEN m.user_id IS NULL THEN c.access_mode = 'workspace' ELSE m.can_view AND m.can_use
        AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp()) END)
      AND (CASE WHEN a.agent_id IS NULL THEN c.access_mode = 'workspace' ELSE a.enabled
        AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > statement_timestamp()) END)
  );
$$;
REVOKE ALL ON FUNCTION connector_result_private.admitted(uuid,uuid,uuid,uuid,uuid,text,boolean,integer,integer,text)
  FROM PUBLIC, anon, authenticated, service_role;

-- A missing migration or a destination denial must stop dispatch. Perform the same
-- authorization again in the write transaction; do not insert the provider envelope.
CREATE FUNCTION public.connector_private_result_ready(
  p_site_id uuid, p_user_id uuid, p_instance_id uuid, p_agent_id uuid, p_connector_id uuid,
  p_tool text, p_catalog boolean, p_connector_revision integer, p_policy_revision integer, p_credential_revision text
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT current_setting('role',true) = 'service_role' AND connector_result_private.admitted(
    p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_tool,p_catalog,p_connector_revision,p_policy_revision,p_credential_revision);
$$;
REVOKE ALL ON FUNCTION public.connector_private_result_ready(uuid,uuid,uuid,uuid,uuid,text,boolean,integer,integer,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.connector_private_result_ready(uuid,uuid,uuid,uuid,uuid,text,boolean,integer,integer,text) TO service_role;

CREATE FUNCTION public.store_connector_private_result(
  p_site_id uuid, p_user_id uuid, p_instance_id uuid, p_agent_id uuid, p_connector_id uuid,
  p_tool text, p_catalog boolean, p_connector_revision integer, p_policy_revision integer, p_credential_revision text,
  p_version text, p_schema_hash text, p_report jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE receipt uuid;
BEGIN
  IF public.connector_private_result_ready(p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_tool,p_catalog,
    p_connector_revision,p_policy_revision,p_credential_revision) IS NOT TRUE THEN
    RAISE EXCEPTION 'Private destination unavailable' USING ERRCODE = '42501';
  END IF;
  -- Bound stored reports per owner even under concurrent completions. Expiry is also
  -- checked at read, independent of this opportunistic physical cleanup.
  PERFORM pg_advisory_xact_lock(hashtextextended('connector-private-results:' || p_user_id::text,0));
  DELETE FROM connector_result_private.reports WHERE id IN (SELECT id FROM connector_result_private.reports
    WHERE expires_at <= statement_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED);
  DELETE FROM connector_result_private.reports WHERE id IN (SELECT id FROM connector_result_private.reports
    WHERE owner_id = p_user_id ORDER BY created_at DESC,id OFFSET 19);
  INSERT INTO connector_result_private.reports(site_id,owner_id,instance_id,agent_id,connector_id,tool,catalog,
    connector_revision,policy_revision,credential_revision,version,schema_hash,report)
  VALUES (p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_tool,p_catalog,
    p_connector_revision,p_policy_revision,p_credential_revision,p_version,p_schema_hash,p_report) RETURNING id INTO receipt;
  RETURN receipt;
END;
$$;
REVOKE ALL ON FUNCTION public.store_connector_private_result(uuid,uuid,uuid,uuid,uuid,text,boolean,integer,integer,text,text,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.store_connector_private_result(uuid,uuid,uuid,uuid,uuid,text,boolean,integer,integer,text,text,text,jsonb) TO service_role;

-- A dedicated non-login, non-BYPASSRLS reader executes the user-facing definer
-- functions. It inherits authenticated SELECT policies on remote_instances (including
-- restrictive procurement, location and future row guards), never postgres visibility.
-- New roles default to non-superuser/non-BYPASSRLS. Do not request privileged
-- role attributes from hosted postgres, or reuse a pre-existing role.
CREATE ROLE connector_result_reader NOLOGIN NOCREATEDB NOCREATEROLE INHERIT;
GRANT authenticated TO connector_result_reader;
GRANT connector_result_reader TO CURRENT_USER;
GRANT USAGE ON SCHEMA connector_result_private TO connector_result_reader;
GRANT SELECT ON connector_result_private.reports TO connector_result_reader;
CREATE POLICY read_own_unexpired_report ON connector_result_private.reports FOR SELECT TO connector_result_reader
  USING (owner_id = auth.uid() AND expires_at > statement_timestamp());

-- Actor is never a caller parameter. Unknown, expired and inaccessible IDs look the
-- same. Do not expose this through a model tool or a service-role lookup by owner.
CREATE FUNCTION connector_result_private.visible(r connector_result_private.reports)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT current_setting('role',true) = 'authenticated' AND auth.jwt()->'is_anonymous' = 'false'::jsonb
    AND r.owner_id = auth.uid() AND r.expires_at > statement_timestamp()
    AND EXISTS (SELECT 1 FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id) = (r.instance_id,r.site_id,auth.uid()))
    AND connector_result_private.admitted(
      r.site_id,r.owner_id,r.instance_id,r.agent_id,r.connector_id,r.tool,r.catalog,r.connector_revision,r.policy_revision,r.credential_revision);
$$;
REVOKE ALL ON FUNCTION connector_result_private.visible(connector_result_private.reports) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION connector_result_private.admitted(uuid,uuid,uuid,uuid,uuid,text,boolean,integer,integer,text),
  connector_result_private.visible(connector_result_private.reports) TO connector_result_reader;
-- POST only. PostgREST must not expose these reads via cacheable GET/HEAD RPCs.
CREATE FUNCTION public.read_connector_private_result(p_id uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.report FROM connector_result_private.reports r
    WHERE r.id = p_id AND r.owner_id = auth.uid() AND connector_result_private.visible(r);
$$;
CREATE FUNCTION public.list_connector_private_results()
RETURNS TABLE(id uuid, tool text, created_at timestamptz) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id,r.tool,r.created_at FROM connector_result_private.reports r
    WHERE r.owner_id = auth.uid() AND connector_result_private.visible(r) ORDER BY r.created_at DESC,r.id LIMIT 20;
$$;
REVOKE ALL ON FUNCTION public.read_connector_private_result(uuid), public.list_connector_private_results() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_connector_private_result(uuid), public.list_connector_private_results() TO authenticated;

-- An explicit browser form selects a server-produced row by index, never by a caller-
-- supplied view, account, SQL, site, agent, pagination token or provider identity.
CREATE FUNCTION public.connector_private_report_choice(p_id uuid, p_choice integer)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('site_id',r.site_id,'user_id',r.owner_id,'instance_id',r.instance_id,
    'agent_id',r.agent_id,'connector_id',r.connector_id,'version',r.version,'schema_hash',r.schema_hash,
    'arguments',CASE WHEN p_choice = -1 THEN jsonb_build_object('after',r.report->>'next_after')
      ELSE jsonb_build_object('view',r.report->'rows'->p_choice->>0) END)
  FROM connector_result_private.reports r WHERE r.id = p_id AND r.owner_id = auth.uid()
    AND r.catalog AND r.tool = 'SUPABASE_RUN_READ_ONLY_QUERY' AND r.report->'published' = 'true'::jsonb
    AND connector_result_private.visible(r) AND (p_choice = -1 AND jsonb_typeof(r.report->'next_after') = 'string'
      OR p_choice BETWEEN 0 AND 24 AND jsonb_typeof(r.report->'rows'->p_choice->0) = 'string');
$$;
REVOKE ALL ON FUNCTION public.connector_private_report_choice(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.connector_private_report_choice(uuid,integer) TO authenticated;

-- ALTER OWNER requires schema CREATE; it is not an ongoing reader privilege.
GRANT CREATE ON SCHEMA public TO connector_result_reader;
ALTER FUNCTION public.read_connector_private_result(uuid) OWNER TO connector_result_reader;
ALTER FUNCTION public.list_connector_private_results() OWNER TO connector_result_reader;
ALTER FUNCTION public.connector_private_report_choice(uuid,integer) OWNER TO connector_result_reader;
REVOKE CREATE ON SCHEMA public FROM connector_result_reader;

COMMIT;