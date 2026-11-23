BEGIN;
SET LOCAL lock_timeout = '5s';

-- Use the existing completed connection, not a second Ask grant. This private
-- view does not issue consent, rewrite attempts, or include unverified accounts.
CREATE INDEX connector_completed_account_idx ON public.site_connector_auth_attempts(site_id,connector_id)
  WHERE status='completed';
CREATE VIEW connector_result_private.ask_connections AS
SELECT c.id AS connector_id,c.site_id,a.id AS attempt_id,c.revision AS connector_revision,
  cp.revision AS policy_revision,p.credential_revision,d.direct_revision,
  jsonb_build_object('authority_kind','verified_connection','connection_attempt_id',a.id,
    'connector',to_jsonb(c),'provider',to_jsonb(p),'direct_revision',d.direct_revision,
    'policy',jsonb_build_object('revision',cp.revision,'allowed_tools',cp.allowed_tools,
      'allowed_hosts',cp.allowed_hosts,'tool_access_mode',cp.tool_access_mode,'require_approval',cp.require_approval)) AS wire
FROM public.connectors c
JOIN public.site_connector_providers p ON (p.id,p.site_id,p.project_id)=(c.provider_id,c.site_id,c.provider_project_id)
JOIN public.site_connector_auth_attempts a ON (a.connector_id,a.site_id,a.user_id,a.provider_id,a.toolkit_slug,a.provider_account_id,a.auth_config_id,a.credential_revision)=
  (c.id,c.site_id,c.created_by,p.id,c.toolkit_slug,c.provider_account_id,c.auth_config_id,p.credential_revision)
JOIN public.connector_policies cp ON (cp.connector_id,cp.site_id)=(c.id,c.site_id)
JOIN connector_result_private.direct_revisions d ON d.connector_id=c.id
LEFT JOIN public.site_secrets s ON s.site_id=c.site_id AND s.instance_id IS NULL AND s.provider='composio' AND s.use_case='integrations'
WHERE a.status='completed' AND c.enabled AND c.verified_at IS NOT NULL AND c.provider_status='ACTIVE'
  AND NOT c.revocation_pending AND NOT c.revocation_dispatched AND c.provider_account_id<>'instant_account'
  AND p.provider='composio' AND p.status='active' AND p.provider_user_id=c.site_id::text
  AND (c.toolkit_slug<>'supabase' OR c.supabase_project_ref COLLATE "C" ~ '^[a-z]{20}$')
  -- A legacy attempt can predate the immutable pin on its connector. If the
  -- attempt recorded a project, it must still match; never fill or rewrite the pin.
  AND (a.supabase_project_ref IS NULL OR a.supabase_project_ref=c.supabase_project_ref)
  AND (CASE WHEN s.site_id IS NULL THEN p.credential_revision COLLATE "C" ~ '^platform:[a-f0-9]{64}$' ELSE
    s.is_active IS TRUE AND p.credential_revision=encode(sha256(convert_to(s.encrypted_value,'UTF8')),'hex') AND EXISTS (
      SELECT FROM connector_result_private.provider_attestations b
      WHERE (b.site_id,b.credential_revision,b.project_id)=(p.site_id,p.credential_revision,p.project_id)) END);

CREATE FUNCTION connector_result_private.ask_connection_admissions(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_slug text)
RETURNS SETOF connector_result_private.ask_connections LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT o.* FROM connector_result_private.instance_policy_accounts(p_site_id,p_user_id,p_connector_id,p_slug) a
    JOIN connector_result_private.ask_connections o ON (o.site_id,o.connector_id)=(p_site_id,a.connector_id)
  WHERE connector_result_private.direct_actor(p_site_id,p_user_id,p_instance_id,p_agent_id)
    -- Generic catalog actions have no trusted per-action business screen mapping.
    AND NOT EXISTS (SELECT FROM public.site_members m WHERE (m.site_id,m.user_id)=(p_site_id,p_user_id)
      AND cardinality(m.blocked_screens) IS DISTINCT FROM 0);
$$;

CREATE FUNCTION public.connector_ask_connections(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_slug text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  SELECT coalesce(jsonb_agg(o.wire ORDER BY o.connector_id),'[]') INTO result FROM (
    SELECT * FROM connector_result_private.ask_connection_admissions(p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_slug) LIMIT 101
  ) o;
  IF jsonb_array_length(result)>100 THEN RAISE EXCEPTION 'Narrow to an account' USING ERRCODE='P0D02'; END IF;
  RETURN result;
END $$;

-- Reuse the existing receipt identity and revision fence. These revision rows
-- are concurrency metadata only, not grants. Keep earlier receipts on the old contract.
CREATE FUNCTION connector_result_private.seed_ask_connection_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO connector_result_private.direct_revisions(connector_id,direct_revision) VALUES (NEW.connector_id,1)
    ON CONFLICT (connector_id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER seed_ask_connection_revision AFTER INSERT ON public.connector_audit_events FOR EACH ROW
  WHEN (NEW.event_type='auth_completed') EXECUTE FUNCTION connector_result_private.seed_ask_connection_revision();
INSERT INTO connector_result_private.direct_revisions(connector_id,direct_revision)
  SELECT c.id,1 FROM public.connectors c ON CONFLICT (connector_id) DO NOTHING;

-- Keep old and in-flight turns on their original contract. Only the new
-- trusted ingress opts in on INSERT, so do not re-stamp old authority epochs.
ALTER TABLE connector_result_private.direct_ask_submissions ADD COLUMN connection_policy boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION connector_result_private.reserve_ask_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (current_setting('role',true) IN ('postgres','service_role','supabase_admin') OR
    (current_setting('role',true)='none' AND session_user=current_user)) OR NEW.log_type IS DISTINCT FROM 'user_action'
    OR NEW.trusted_user_action IS NOT TRUE OR (NEW.details->>'ask_request_sha256' COLLATE "C" ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN
    RAISE insufficient_privilege;
  END IF;
  INSERT INTO connector_result_private.direct_ask_submissions(action_id,connection_policy)
    VALUES (NEW.id,(NEW.details->'ask_connection_policy'='true'::jsonb) IS TRUE);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION connector_result_private.advance_direct_turn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('role',true) IN ('postgres','service_role','supabase_admin') OR
     (current_setting('role',true)='none' AND session_user=current_user) THEN
    -- A head is not a grant. It records only the snapshot of the latest trusted turn.
    IF EXISTS (SELECT FROM public.connectors c WHERE c.site_id=NEW.site_id AND c.enabled) THEN
      INSERT INTO connector_result_private.direct_turn_heads AS h(instance_id,site_id,action_id,action_created_at,admission_snapshot)
      VALUES (NEW.instance_id,NEW.site_id,NEW.id,NEW.created_at,pg_current_snapshot()) ON CONFLICT (instance_id) DO UPDATE SET
        site_id=EXCLUDED.site_id,action_id=EXCLUDED.action_id,action_created_at=EXCLUDED.action_created_at,
        admission_snapshot=EXCLUDED.admission_snapshot
      WHERE (h.action_created_at,h.action_id)<(EXCLUDED.action_created_at,EXCLUDED.action_id);
    ELSE
      DELETE FROM connector_result_private.direct_turn_heads WHERE instance_id=NEW.instance_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION connector_result_private.account_claim_admitted(c connector_result_private.direct_claims) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.tool IS NOT NULL AND c.authorization_id IS NOT NULL AND c.attestation_id IS NULL AND c.data_scope IS NULL
    AND EXISTS (SELECT FROM connector_result_private.direct_ask_submissions s WHERE s.action_id=c.request_id AND s.account_authority
      AND CASE WHEN s.connection_policy THEN EXISTS (
        SELECT FROM connector_result_private.ask_connection_admissions(c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id,c.tool) a
        WHERE (a.connector_id,a.attempt_id,a.connector_revision,a.policy_revision,a.direct_revision,a.credential_revision)=
          (c.connector_id,c.authorization_id,c.connector_revision,c.policy_revision,c.direct_revision,c.credential_revision))
      ELSE EXISTS (SELECT FROM connector_result_private.ordinary_admissions(c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id,c.tool) a
        WHERE (a.connector_id,a.authorization_id,a.connector_revision,a.policy_revision,a.direct_revision,a.credential_revision)=
          (c.connector_id,c.authorization_id,c.connector_revision,c.policy_revision,c.direct_revision,c.credential_revision)) END);
$$;

-- Keep the deployed status DTO. The flag denotes the local connection check,
-- not live downstream permissions or the ability to run any particular action.
CREATE OR REPLACE FUNCTION public.connector_instance_policy_status(p_site_id uuid,p_actor_id uuid,p_connector_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r jsonb; assistant_allowed boolean;
BEGIN
  r := public.connector_ask_policy_status(p_site_id,p_actor_id,p_connector_id);
  assistant_allowed := NOT connector_result_private.direct_disabled(p_connector_id);
  IF EXISTS (SELECT FROM connector_result_private.ask_connections o WHERE (o.site_id,o.connector_id)=(p_site_id,p_connector_id)) THEN
    r := r || jsonb_build_object('authority_kind','connected_account','enabled',assistant_allowed,'setup_pending',false,'attested',false);
  ELSE
    r := r || jsonb_build_object('enabled',false,'setup_pending',false,'attested',false);
  END IF;
  RETURN r || jsonb_build_object('authorization_mode','host_policy','assistant_allowed',assistant_allowed);
END $$;

REVOKE ALL ON connector_result_private.ask_connections FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
REVOKE ALL ON FUNCTION connector_result_private.ask_connection_admissions(uuid,uuid,uuid,uuid,uuid,text),
  connector_result_private.seed_ask_connection_revision(), public.connector_ask_connections(uuid,uuid,uuid,uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_ask_connections(uuid,uuid,uuid,uuid,uuid,text) TO service_role;
COMMIT;