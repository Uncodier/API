BEGIN;
SET LOCAL lock_timeout = '5s';

-- No API mutation or table grants. Only a trusted database operator can issue or revoke
-- a platform entitlement. It is independent of site ownership and of connector-use grants.
CREATE TABLE connector_result_private.analytics_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL, agent_id uuid NOT NULL,
  project_ref text NOT NULL CHECK (project_ref ~ '^[a-z]{20}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(), granted_by name NOT NULL DEFAULT current_user,
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at) AND expires_at > created_at), revoked_at timestamptz,
  FOREIGN KEY (connector_id,site_id) REFERENCES public.connectors(id,site_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id,site_id) REFERENCES public.agents(id,site_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX analytics_one_outstanding_grant ON connector_result_private.analytics_grants
  (site_id,user_id,connector_id,agent_id,project_ref) WHERE revoked_at IS NULL;
ALTER TABLE connector_result_private.analytics_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.analytics_grants FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE FUNCTION connector_result_private.guard_analytics_grant() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.id := gen_random_uuid(); NEW.granted_by := current_user; NEW.created_at := statement_timestamp();
    IF NEW.revoked_at IS NOT NULL OR NOT EXISTS (SELECT FROM public.connectors c
      WHERE (c.id,c.site_id,c.supabase_project_ref) = (NEW.connector_id,NEW.site_id,NEW.project_ref)
        AND c.toolkit_slug='supabase' AND c.verified_at IS NOT NULL AND c.provider_status='ACTIVE'
        AND c.enabled AND NOT c.revocation_pending AND NOT c.revocation_dispatched) THEN
      RAISE EXCEPTION 'Verified project binding required' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND
    to_jsonb(NEW) - 'revoked_at' = to_jsonb(OLD) - 'revoked_at' THEN
    NEW.revoked_at := statement_timestamp();
  ELSE RAISE EXCEPTION 'Issue a new grant instead of changing an entitlement' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.guard_analytics_grant() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER analytics_grant_issuance BEFORE INSERT OR UPDATE ON connector_result_private.analytics_grants
  FOR EACH ROW EXECUTE FUNCTION connector_result_private.guard_analytics_grant();

-- NULL scope denotes legacy/published reports; it is never an alias for platform.
ALTER TABLE connector_result_private.reports
  ADD COLUMN data_scope text, ADD COLUMN project_ref text, ADD COLUMN source_name text, ADD COLUMN grant_id uuid,
  ADD CHECK ((data_scope IS NULL AND project_ref IS NULL AND source_name IS NULL AND grant_id IS NULL) OR
    (data_scope IS NOT NULL AND project_ref IS NOT NULL AND source_name IS NOT NULL AND catalog
    AND tool='SUPABASE_RUN_READ_ONLY_QUERY' AND project_ref ~ '^[a-z]{20}$' AND source_name ~ '^[a-z][a-z0-9_]{0,47}$'
    AND ((data_scope='workspace' AND grant_id IS NULL) OR (data_scope='platform' AND grant_id IS NOT NULL))));

-- Intentionally no FK from reports to grants: removing the exact epoch must hide (not
-- convert or resurrect) the private report. Both local and saved-data checks use this predicate.
CREATE FUNCTION connector_result_private.analytics_permitted(p_site_id uuid,p_user_id uuid,p_connector_id uuid,p_agent_id uuid,
  p_project_ref text,p_data_scope text,p_source text,p_grant_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_project_ref ~ '^[a-z]{20}$' AND p_source ~ '^[a-z][a-z0-9_]{0,47}$' AND EXISTS (
    SELECT FROM public.connectors c WHERE (c.site_id,c.id,c.supabase_project_ref) = (p_site_id,p_connector_id,p_project_ref)
    AND c.toolkit_slug='supabase' AND c.verified_at IS NOT NULL AND c.provider_status='ACTIVE' AND c.enabled
    AND NOT c.revocation_pending AND NOT c.revocation_dispatched)
    AND (p_source NOT IN ('tender_awards','approved_orders') OR EXISTS (
      SELECT FROM public.connector_effective_site_access(p_site_id,p_user_id) a WHERE a.can_manage))
    AND ((p_data_scope='workspace' AND p_grant_id IS NULL) OR (p_data_scope='platform' AND EXISTS (
      SELECT FROM connector_result_private.analytics_grants g WHERE
      (g.site_id,g.user_id,g.connector_id,g.agent_id,g.project_ref,g.id) =
      (p_site_id,p_user_id,p_connector_id,p_agent_id,p_project_ref,p_grant_id)
      AND g.revoked_at IS NULL AND g.expires_at > statement_timestamp())));
$$;
REVOKE ALL ON FUNCTION connector_result_private.analytics_permitted(uuid,uuid,uuid,uuid,text,text,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION connector_result_private.analytics_permitted(uuid,uuid,uuid,uuid,text,text,text,uuid) TO connector_result_reader;

CREATE FUNCTION public.connector_analytics_result_ready(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,
  p_tool text,p_catalog boolean,p_connector_revision integer,p_policy_revision integer,p_credential_revision text,
  p_project_ref text,p_data_scope text,p_source text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE grant_id uuid; allowed boolean;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  IF p_data_scope='platform' THEN
    SELECT g.id INTO grant_id FROM connector_result_private.analytics_grants g WHERE
      (g.site_id,g.user_id,g.connector_id,g.agent_id,g.project_ref)=(p_site_id,p_user_id,p_connector_id,p_agent_id,p_project_ref)
      AND g.revoked_at IS NULL AND g.expires_at > statement_timestamp();
  END IF;
  allowed := p_tool='SUPABASE_RUN_READ_ONLY_QUERY' AND p_catalog AND public.connector_private_result_ready(
    p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_tool,p_catalog,p_connector_revision,p_policy_revision,p_credential_revision)
    AND connector_result_private.analytics_permitted(p_site_id,p_user_id,p_connector_id,p_agent_id,p_project_ref,p_data_scope,p_source,grant_id);
  RETURN jsonb_build_object('allowed',allowed IS TRUE,'grant_id',CASE WHEN allowed THEN grant_id END);
END $$;
REVOKE ALL ON FUNCTION public.connector_analytics_result_ready(uuid,uuid,uuid,uuid,uuid,text,boolean,integer,integer,text,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.connector_analytics_result_ready(uuid,uuid,uuid,uuid,uuid,text,boolean,integer,integer,text,text,text,text) TO service_role;

CREATE FUNCTION public.store_connector_analytics_result(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,
  p_tool text,p_catalog boolean,p_connector_revision integer,p_policy_revision integer,p_credential_revision text,
  p_version text,p_schema_hash text,p_report jsonb,p_project_ref text,p_data_scope text,p_source text,p_grant_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE receipt uuid; stamp jsonb;
BEGIN
  stamp := public.connector_analytics_result_ready(p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_tool,p_catalog,
    p_connector_revision,p_policy_revision,p_credential_revision,p_project_ref,p_data_scope,p_source);
  IF (stamp->>'allowed')::boolean IS NOT TRUE OR (stamp->>'grant_id')::uuid IS DISTINCT FROM p_grant_id THEN
    RAISE EXCEPTION 'Private analytics destination unavailable' USING ERRCODE='42501';
  END IF;
  -- Legacy destination handles retention, byte limits and the ordinary admission checks.
  -- No unmarked row is ever committed or visible between creation and stamping.
  receipt := public.store_connector_private_result(p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_tool,p_catalog,
    p_connector_revision,p_policy_revision,p_credential_revision,p_version,p_schema_hash,p_report);
  IF p_data_scope='platform' THEN
    -- Retention in the preceding RPC may wait for another completion. Serialize the final
    -- stamp with operator revocation and use wall time after that wait. Failure rolls back
    -- the entire uncommitted receipt. Reads still check their own current snapshot and TTL.
    PERFORM 1 FROM connector_result_private.analytics_grants g WHERE g.id=p_grant_id AND
      (g.site_id,g.user_id,g.connector_id,g.agent_id,g.project_ref)=(p_site_id,p_user_id,p_connector_id,p_agent_id,p_project_ref)
      AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Private analytics destination unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  UPDATE connector_result_private.reports SET data_scope=p_data_scope,project_ref=p_project_ref,source_name=p_source,grant_id=p_grant_id
    WHERE id=receipt;
  IF NOT FOUND THEN RAISE EXCEPTION 'Private analytics store failed'; END IF;
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.store_connector_analytics_result(uuid,uuid,uuid,uuid,uuid,text,boolean,integer,integer,text,text,text,jsonb,text,text,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.store_connector_analytics_result(uuid,uuid,uuid,uuid,uuid,text,boolean,integer,integer,text,text,text,jsonb,text,text,text,uuid) TO service_role;

-- Preserve all previous reader and parent RLS checks; authenticated-only read, list, and
-- selection RPCs share this predicate. The caller cannot select a scope or a grant epoch.
CREATE OR REPLACE FUNCTION connector_result_private.visible(r connector_result_private.reports)
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT current_setting('role',true)='authenticated' AND auth.jwt()->'is_anonymous'='false'::jsonb
    AND r.owner_id=auth.uid() AND r.expires_at>statement_timestamp()
    AND EXISTS (SELECT FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id)=(r.instance_id,r.site_id,auth.uid()))
    AND connector_result_private.admitted(r.site_id,r.owner_id,r.instance_id,r.agent_id,r.connector_id,r.tool,r.catalog,
      r.connector_revision,r.policy_revision,r.credential_revision)
    AND (r.data_scope IS NULL OR connector_result_private.analytics_permitted(r.site_id,auth.uid(),r.connector_id,r.agent_id,
      r.project_ref,r.data_scope,r.source_name,r.grant_id));
$$;

COMMIT;