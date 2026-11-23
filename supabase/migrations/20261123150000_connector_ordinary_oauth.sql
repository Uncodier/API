BEGIN;
SET LOCAL lock_timeout = '5s';

-- Positive whole-account grant profiles, not a catalogue of tool names. An
-- unfamiliar scope (including settings, admin, or a generic API grant) fails
-- closed. The provider, not the model, enforces these scopes on every action.
CREATE FUNCTION connector_result_private.business_screens(kit text, scopes text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT CASE WHEN cardinality(scopes)>0 AND array_position(scopes,NULL) IS NULL THEN CASE
    WHEN kit='gmail' AND scopes <@ ARRAY['https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify','https://www.googleapis.com/auth/gmail.send'] THEN ARRAY['chat']
    WHEN kit='googlecalendar' AND scopes <@ ARRAY['https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.events.readonly'] THEN ARRAY['calendar','reservations']
    WHEN kit='hubspot' AND NOT scopes <@ ARRAY['oauth'] AND scopes <@ ARRAY['oauth',
      'crm.objects.contacts.read','crm.objects.contacts.write','crm.objects.companies.read','crm.objects.companies.write',
      'crm.objects.deals.read','crm.objects.deals.write'] THEN ARRAY['people','leads','deals']
    END END;
$$;

-- No history backfill: old callbacks accepted an absent account type. Only
-- the provider-verifying hosted callback may record this positive evidence.
CREATE TABLE connector_result_private.ordinary_oauth_accounts (
  site_id uuid NOT NULL, connector_id uuid PRIMARY KEY, granted_scopes text[] NOT NULL,
  authorization_id uuid NOT NULL UNIQUE REFERENCES public.site_connector_auth_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (connector_id,site_id) REFERENCES public.connectors(id,site_id) ON DELETE CASCADE
);
CREATE INDEX ordinary_oauth_site_idx ON connector_result_private.ordinary_oauth_accounts(site_id,connector_id);
ALTER TABLE connector_result_private.ordinary_oauth_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.ordinary_oauth_accounts FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;

CREATE FUNCTION public.connector_finalize_private_oauth(
  p_attempt_id uuid,p_actor_id uuid,p_nonce_hash text,p_provider_account_id text,
  p_toolkit_slug text,p_auth_config_id text,p_display_name text,p_granted_scopes text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb; a public.site_connector_auth_attempts%ROWTYPE;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO a FROM public.site_connector_auth_attempts WHERE id=p_attempt_id FOR UPDATE;
  -- No upgrades on replay. Delegate nonce, pinned identity, current manager,
  -- credential revision, expiry and atomic account creation to the finalizer.
  result := public.connector_finalize_auth(p_attempt_id,p_actor_id,p_nonce_hash,p_provider_account_id,
    p_toolkit_slug,p_auth_config_id,p_display_name,p_granted_scopes);
  IF a.status='completing' AND a.ask_on_connect AND a.supabase_project_ref IS NULL AND p_provider_account_id<>'instant_account'
    AND connector_result_private.business_screens(p_toolkit_slug,p_granted_scopes) IS NOT NULL THEN
    INSERT INTO connector_result_private.ordinary_oauth_accounts(site_id,connector_id,authorization_id,granted_scopes)
      VALUES (a.site_id,(result->>'id')::uuid,a.id,p_granted_scopes);
    INSERT INTO connector_result_private.direct_revisions(connector_id,direct_revision) VALUES ((result->>'id')::uuid,1)
      ON CONFLICT (connector_id) DO UPDATE SET setup_credential_revision=NULL,authority_xid=pg_current_xact_id();
  END IF;
  RETURN result;
END $$;

-- A subsequent explicit resource proof supersedes ordinary authority once,
-- not temporarily: revocation/expiry/deletion cannot downgrade back to OAuth.
CREATE FUNCTION connector_result_private.retire_ordinary_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM connector_result_private.ordinary_oauth_accounts WHERE connector_id=NEW.connector_id;
  RETURN NULL;
END $$;
CREATE TRIGGER retire_ordinary_authority AFTER INSERT ON connector_result_private.direct_attestations
  FOR EACH ROW EXECUTE FUNCTION connector_result_private.retire_ordinary_authority();

CREATE VIEW connector_result_private.ordinary_accounts AS
SELECT c.id AS connector_id,c.site_id,o.authorization_id,c.revision AS connector_revision,cp.revision AS policy_revision,
  p.credential_revision,d.direct_revision,connector_result_private.business_screens(c.toolkit_slug,o.granted_scopes) AS required_screens,
  c.toolkit_slug,cp.tool_access_mode,cp.allowed_tools,cp.allowed_hosts,
  jsonb_build_object('authority_kind','connected_account','authorization_id',o.authorization_id,'connector',to_jsonb(c),
    'provider',to_jsonb(p),'policy',jsonb_build_object('revision',cp.revision,'allowed_tools',cp.allowed_tools,'allowed_hosts',cp.allowed_hosts,
    'tool_access_mode',cp.tool_access_mode,'require_approval',cp.require_approval),'direct_revision',d.direct_revision) AS wire
FROM connector_result_private.ordinary_oauth_accounts o
JOIN public.site_connector_auth_attempts a ON (a.id,a.site_id,a.connector_id)=(o.authorization_id,o.site_id,o.connector_id)
JOIN public.connectors c ON (c.site_id,c.id,c.created_by,c.provider_id,c.toolkit_slug,c.provider_account_id,c.auth_config_id)=
  (a.site_id,a.connector_id,a.user_id,a.provider_id,a.toolkit_slug,a.provider_account_id,a.auth_config_id)
JOIN public.site_connector_providers p ON (p.id,p.site_id,p.project_id,p.credential_revision)=
  (c.provider_id,c.site_id,c.provider_project_id,a.credential_revision)
JOIN public.connector_policies cp ON (cp.connector_id,cp.site_id)=(c.id,c.site_id)
JOIN connector_result_private.direct_revisions d ON d.connector_id=c.id
LEFT JOIN public.site_secrets s ON s.site_id=c.site_id AND s.provider='composio' AND s.use_case='integrations' AND s.instance_id IS NULL
WHERE a.status='completed' AND a.ask_on_connect AND a.supabase_project_ref IS NULL AND c.supabase_project_ref IS NULL
  AND c.provider_account_id<>'instant_account' AND c.enabled AND c.verified_at IS NOT NULL AND c.provider_status='ACTIVE'
  AND NOT c.revocation_dispatched AND NOT c.revocation_pending AND p.status='active' AND p.provider='composio' AND p.provider_user_id=c.site_id::text
  AND connector_result_private.business_screens(c.toolkit_slug,o.granted_scopes) IS NOT NULL
  AND c.granted_scopes @> o.granted_scopes AND c.granted_scopes <@ o.granted_scopes
  AND (CASE WHEN s.site_id IS NULL THEN p.credential_revision COLLATE "C" ~ '^platform:[a-f0-9]{64}$' ELSE
    s.is_active IS TRUE AND p.credential_revision=encode(sha256(convert_to(s.encrypted_value,'UTF8')),'hex') AND EXISTS (
      SELECT FROM connector_result_private.provider_attestations b WHERE
        (b.site_id,b.credential_revision,b.project_id)=(p.site_id,p.credential_revision,p.project_id)) END);
REVOKE ALL ON connector_result_private.ordinary_accounts FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;

CREATE FUNCTION connector_result_private.ordinary_authorization(p_site_id uuid,p_connector_id uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT authorization_id FROM connector_result_private.ordinary_accounts WHERE (site_id,connector_id)=(p_site_id,p_connector_id);
$$;

-- Negative evidence only. This RPC resolves an account, not a dispatch
-- permit: the runtime also verifies the live tool, schema, args and credential.
CREATE FUNCTION connector_result_private.ordinary_slug(kit text,slug text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT starts_with(slug,upper(kit)||'_') AND length(slug)<=150
    AND slug COLLATE "C" ~ '^[A-Z0-9]+(_[A-Z0-9]+)+$'
    AND slug COLLATE "C" !~ '_(SQL|ADMIN|IAM|RBAC|ROLE|ROLES|PERMISSION|PERMISSIONS|CREDENTIALS?|OAUTH|TOKENS?|SECRETS?|PROXY|EXECUTE|CODE|SHELL|SCRIPT|DEPLOY|WEBHOOK|WORKFLOW|RPC|RAW|GRAPHQL)(_|$)';
$$;
CREATE FUNCTION connector_result_private.ordinary_tool_allowed(kit text,mode text,tools text[],slug text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN slug IS NULL THEN mode='all' OR (mode='selected' AND EXISTS (
    SELECT FROM unnest(tools) t WHERE connector_result_private.ordinary_slug(kit,t))) ELSE
    connector_result_private.ordinary_slug(kit,slug) AND (mode='all' OR (mode='selected' AND slug=ANY(tools))) END;
$$;

CREATE FUNCTION connector_result_private.ordinary_admissions(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_slug text)
RETURNS TABLE(connector_id uuid,authorization_id uuid,connector_revision integer,policy_revision integer,credential_revision text,direct_revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.connector_id,o.authorization_id,o.connector_revision,o.policy_revision,o.credential_revision,o.direct_revision
  FROM connector_result_private.instance_policy_accounts(p_site_id,p_user_id,p_connector_id,p_slug) a
  JOIN connector_result_private.ordinary_accounts o ON (o.connector_id,o.site_id)=(a.connector_id,p_site_id)
  WHERE connector_result_private.direct_actor(p_site_id,p_user_id,p_instance_id,p_agent_id)
    AND connector_result_private.ordinary_tool_allowed(o.toolkit_slug,o.tool_access_mode,o.allowed_tools,p_slug)
    AND NOT EXISTS (SELECT FROM public.site_members m WHERE (m.site_id,m.user_id)=(o.site_id,p_user_id) AND m.blocked_screens && o.required_screens);
$$;

CREATE FUNCTION public.connector_direct_accounts_v2(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_slug text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  SELECT coalesce(jsonb_agg(rowdata ORDER BY rowdata->'connector'->>'id'),'[]') INTO result FROM (
    SELECT value AS rowdata FROM jsonb_array_elements(public.connector_direct_accounts(p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_slug))
    UNION ALL (SELECT o.wire FROM connector_result_private.ordinary_admissions(p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_slug) a
      JOIN connector_result_private.ordinary_accounts o USING (connector_id) LIMIT 101)) eligible;
  IF jsonb_array_length(result)>100 THEN RAISE EXCEPTION 'Narrow to an account' USING ERRCODE='P0D02'; END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.connector_support_agent_account_v2(p_site_id uuid,p_agent_id uuid,p_connector_id uuid,p_slug text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  result := public.connector_support_agent_account(p_site_id,p_agent_id,p_connector_id,p_slug);
  IF jsonb_array_length(result)>0 THEN RETURN result; END IF;
  SELECT coalesce(jsonb_agg(o.wire || jsonb_build_object('required_screens',o.required_screens)),'[]') INTO result
    FROM connector_result_private.ordinary_accounts o
    JOIN public.sites s ON s.id=o.site_id AND s.archived_at IS NULL
    JOIN public.agents a ON (a.site_id,a.id)=(s.id,p_agent_id) AND a.role='Customer Support' AND a.status='active'
    JOIN public.connector_agents g ON (g.site_id,g.connector_id,g.agent_id)=(s.id,o.connector_id,a.id)
    WHERE (o.site_id,o.connector_id)=(p_site_id,p_connector_id) AND g.enabled AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp()) AND 'assistant'=ANY(o.allowed_hosts)
      AND NOT connector_result_private.direct_disabled(o.connector_id)
      AND connector_result_private.ordinary_tool_allowed(o.toolkit_slug,o.tool_access_mode,o.allowed_tools,p_slug);
  IF jsonb_array_length(result)>1 THEN RAISE cardinality_violation; END IF;
  RETURN result;
END $$;

-- Preserve the old status DTO and all attested mutation paths. A deliberate
-- ordinary re-enable advances the same CAS epoch and journal without inventing
-- a resource proof or attaching a legacy direct enrollment.
CREATE OR REPLACE FUNCTION public.connector_instance_policy_status(p_site_id uuid,p_actor_id uuid,p_connector_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r jsonb; disabled boolean;
BEGIN
  r := public.connector_ask_policy_status(p_site_id,p_actor_id,p_connector_id);
  disabled := connector_result_private.direct_disabled(p_connector_id);
  IF connector_result_private.ordinary_authorization(p_site_id,p_connector_id) IS NOT NULL THEN
    r := r || jsonb_build_object('authority_kind','connected_account','enabled',NOT disabled,'setup_pending',false);
  END IF;
  RETURN r || jsonb_build_object('authorization_mode','member_policy','explicitly_disabled',disabled);
END $$;

CREATE OR REPLACE FUNCTION public.connector_set_ask_policy(p_site_id uuid,p_actor_id uuid,p_connector_id uuid,
  p_expected_revision integer,p_expected_direct_revision integer,p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE epoch integer; prior uuid;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  prior := connector_result_private.ordinary_authorization(p_site_id,p_connector_id);
  IF prior IS NULL THEN
    PERFORM public.connector_set_direct_policy(p_site_id,p_actor_id,p_connector_id,p_expected_revision,p_expected_direct_revision,p_enabled);
    RETURN public.connector_ask_policy_status(p_site_id,p_actor_id,p_connector_id);
  END IF;
  PERFORM public.connector_lock_for_manager(p_site_id,p_connector_id,p_actor_id,p_expected_revision);
  IF p_enabled IS NULL THEN RAISE invalid_parameter_value; END IF;
  UPDATE connector_result_private.direct_revisions SET direct_revision=direct_revision+1
    WHERE connector_id=p_connector_id AND direct_revision=p_expected_direct_revision RETURNING direct_revision INTO epoch;
  IF NOT FOUND OR connector_result_private.ordinary_authorization(p_site_id,p_connector_id) IS DISTINCT FROM prior THEN
    RAISE EXCEPTION 'Account authorization changed' USING ERRCODE='40001'; END IF;
  INSERT INTO connector_result_private.direct_policy_events(connector_id,direct_revision,connector_revision,actor_id,enabled)
    VALUES(p_connector_id,epoch,p_expected_revision,p_actor_id,p_enabled);
  RETURN public.connector_instance_policy_status(p_site_id,p_actor_id,p_connector_id)-'authorization_mode'-'explicitly_disabled';
END $$;

CREATE OR REPLACE FUNCTION public.connector_save_policy_with_ask(
  p_site_id uuid,p_connector_id uuid,p_actor_id uuid,p_expected_revision integer,
  p_allowed_tools text[],p_allowed_hosts text[],p_require_approval boolean,p_enabled boolean,
  p_tool_access_mode text,p_support_publication jsonb,p_catalog_reads boolean,
  p_ask_enabled boolean,p_expected_direct_revision integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE direct_state jsonb; receipt jsonb;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  IF p_ask_enabled IS NULL OR p_ask_enabled IS DISTINCT FROM ('assistant'=ANY(p_allowed_hosts))
    OR p_catalog_reads IS FALSE OR (p_ask_enabled AND (p_enabled IS NOT TRUE OR
      (p_tool_access_mode='all' OR (p_tool_access_mode='selected' AND cardinality(p_allowed_tools)>0)) IS NOT TRUE)) THEN
    RAISE EXCEPTION 'Inconsistent Ask policy' USING ERRCODE='22023';
  END IF;
  direct_state := public.connector_set_ask_policy(p_site_id,p_actor_id,p_connector_id,p_expected_revision,
    p_expected_direct_revision,p_ask_enabled);
  IF p_catalog_reads IS NULL THEN
    receipt := public.connector_update_policy(p_site_id,p_connector_id,p_actor_id,p_expected_revision,p_allowed_tools,
      p_allowed_hosts,p_require_approval,p_enabled,p_tool_access_mode,p_support_publication);
  ELSE
    receipt := public.connector_update_policy(p_site_id,p_connector_id,p_actor_id,p_expected_revision,p_allowed_tools,
      p_allowed_hosts,p_require_approval,p_enabled,p_tool_access_mode,p_support_publication,p_catalog_reads);
  END IF;
  IF p_ask_enabled AND direct_state->>'authority_kind'='connected_account' THEN
    IF connector_result_private.ordinary_authorization(p_site_id,p_connector_id) IS NULL THEN
      RAISE EXCEPTION 'Current account authorization required' USING ERRCODE='40001'; END IF;
  ELSIF p_ask_enabled THEN
    UPDATE connector_result_private.direct_enrollments e SET policy_grant_xid=pg_current_xact_id()
      FROM connector_result_private.direct_bindings b WHERE (e.site_id,e.connector_id)=(p_site_id,p_connector_id)
        AND e.attestation_id=b.id AND b.expires_at>clock_timestamp();
    IF NOT FOUND THEN RAISE EXCEPTION 'Current resource isolation attestation required' USING ERRCODE='P0D01'; END IF;
  END IF;
  RETURN receipt || jsonb_build_object('direct_revision',(direct_state->>'direct_revision')::integer,'ask_enabled',p_ask_enabled);
END $$;
CREATE OR REPLACE FUNCTION public.connector_agent_review_candidates(p_site_id uuid,p_agent_id uuid,p_slug text)
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
      AND jsonb_array_length(public.connector_support_agent_account_v2(p_site_id,p_agent_id,g.connector_id,p_slug))=1
    ORDER BY g.connector_id LIMIT 2;
END $$;
CREATE OR REPLACE FUNCTION public.connector_claim_support_dispatch(
  p_site_id uuid,p_agent_id uuid,p_user_id uuid,p_conversation_id uuid,p_connector_id uuid,p_slug text,p_turn_digest text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  INSERT INTO connector_result_private.support_dispatch_claims(site_id,conversation_id,turn_digest,connector_id,slug)
    SELECT p_site_id,p_conversation_id,p_turn_digest,p_connector_id,p_slug FROM public.conversations t
    WHERE (t.id,t.site_id,t.agent_id,t.user_id)=(p_conversation_id,p_site_id,p_agent_id,p_user_id)
      AND p_turn_digest COLLATE "C" ~ '^[0-9a-f]{64}$' AND p_connector_id IS NOT NULL AND p_slug IS NOT NULL
      AND jsonb_array_length(public.connector_support_agent_account_v2(p_site_id,p_agent_id,p_connector_id,p_slug))=1
    ON CONFLICT DO NOTHING;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION connector_result_private.business_screens(text,text[]),connector_result_private.retire_ordinary_authority(),
  connector_result_private.ordinary_authorization(uuid,uuid),connector_result_private.ordinary_slug(text,text),connector_result_private.ordinary_tool_allowed(text,text,text[],text),
  connector_result_private.ordinary_admissions(uuid,uuid,uuid,uuid,uuid,text),
  public.connector_finalize_private_oauth(uuid,uuid,text,text,text,text,text,text[]),public.connector_direct_accounts_v2(uuid,uuid,uuid,uuid,uuid,text),
  public.connector_support_agent_account_v2(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_finalize_private_oauth(uuid,uuid,text,text,text,text,text,text[]),
  public.connector_direct_accounts_v2(uuid,uuid,uuid,uuid,uuid,text),public.connector_support_agent_account_v2(uuid,uuid,uuid,text) TO service_role;
COMMIT;
