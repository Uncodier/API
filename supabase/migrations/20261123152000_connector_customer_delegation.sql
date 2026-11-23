BEGIN;
SET LOCAL lock_timeout = '5s';

-- One completion record and one receipt kind. NULL means the OLD, scoped
-- ordinary-OAuth contract, not evidence of a particular new auth scheme.
ALTER TABLE connector_result_private.ordinary_oauth_accounts
  ADD COLUMN auth_scheme text CHECK (auth_scheme IN ('OAUTH2','API_KEY')),
  ADD COLUMN bound_project_ref text,
  ADD CONSTRAINT customer_account_project CHECK (CASE WHEN auth_scheme='API_KEY'
    THEN bound_project_ref IS NULL OR bound_project_ref COLLATE "C" ~ '^[a-z0-9]{20}$'
    ELSE bound_project_ref IS NULL END);

-- Called ONLY after the host verifies the actual downstream account. The API
-- key is either entered on the provider-hosted link (exact pending account,
-- redeemed proof and immutable manager consent) or verified against the pinned project. A transport key, config, display name or later project binding is
-- never evidence. No new browser-callable enrollment, scopes or project input.
CREATE FUNCTION public.connector_finalize_customer_account(
  p_attempt_id uuid,p_actor_id uuid,p_nonce_hash text,p_provider_account_id text,
  p_toolkit_slug text,p_auth_config_id text,p_display_name text,p_granted_scopes text[],p_auth_scheme text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.site_connector_auth_attempts%ROWTYPE; result jsonb; account uuid;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO a FROM public.site_connector_auth_attempts WHERE id=p_attempt_id FOR UPDATE;
  -- Serialize the manager check with concurrent membership/ownership removal.
  -- The original finalizer re-evaluates access after these locks are acquired.
  PERFORM FROM public.sites WHERE id=a.site_id FOR SHARE;
  PERFORM FROM public.site_ownership WHERE (site_id,user_id)=(a.site_id,p_actor_id) FOR SHARE;
  PERFORM FROM public.site_members WHERE (site_id,user_id)=(a.site_id,p_actor_id) ORDER BY id FOR SHARE;
  result := public.connector_finalize_auth(p_attempt_id,p_actor_id,p_nonce_hash,p_provider_account_id,
    p_toolkit_slug,p_auth_config_id,p_display_name,p_granted_scopes);
  -- A completed or revoked authorization can never be (re)issued on replay.
  IF a.status='completed' THEN RETURN result; END IF;
  IF p_provider_account_id='instant_account' OR (CASE p_auth_scheme
    WHEN 'OAUTH2' THEN a.ask_on_connect AND a.supabase_project_ref IS NULL
    WHEN 'API_KEY' THEN a.supabase_project_ref IS NOT NULL OR (a.ask_on_connect AND a.toolkit_slug<>'supabase')
    ELSE false END) IS NOT TRUE THEN RAISE insufficient_privilege; END IF;
  -- A hosted OAuth connection is still useful on its own, but database
  -- execution needs a project proven at submission (never a later binding).
  IF p_toolkit_slug='supabase' AND a.supabase_project_ref IS NULL THEN RETURN result; END IF;
  account := (result->>'id')::uuid;
  INSERT INTO connector_result_private.ordinary_oauth_accounts
    (site_id,connector_id,authorization_id,granted_scopes,auth_scheme,bound_project_ref)
    VALUES (a.site_id,account,a.id,p_granted_scopes,p_auth_scheme,a.supabase_project_ref);
  INSERT INTO connector_result_private.direct_revisions(connector_id,direct_revision) VALUES (account,1)
    ON CONFLICT (connector_id) DO UPDATE SET setup_credential_revision=NULL,authority_xid=pg_current_xact_id();
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.connector_finalize_customer_account(uuid,uuid,text,text,text,text,text,text[],text)
  FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_finalize_customer_account(uuid,uuid,text,text,text,text,text,text[],text) TO service_role;

-- No history backfill. The old PAT disclosure excluded Ask and auth_completed
-- recorded neither the auth scheme nor a decision to delegate a submitted PAT.
CREATE OR REPLACE VIEW connector_result_private.ordinary_accounts AS
SELECT c.id AS connector_id,c.site_id,o.authorization_id,c.revision AS connector_revision,cp.revision AS policy_revision,
  p.credential_revision,d.direct_revision,coalesce(screens.known,ARRAY['*']) AS required_screens,
  c.toolkit_slug,cp.tool_access_mode,cp.allowed_tools,cp.allowed_hosts,
  jsonb_build_object('authority_kind','connected_account','authorization_id',o.authorization_id,'connector',to_jsonb(c),
    'provider',to_jsonb(p),'policy',jsonb_build_object('revision',cp.revision,'allowed_tools',cp.allowed_tools,'allowed_hosts',cp.allowed_hosts,
    'tool_access_mode',cp.tool_access_mode,'require_approval',cp.require_approval),'direct_revision',d.direct_revision)
    || CASE WHEN o.auth_scheme IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
      'auth_scheme',o.auth_scheme,'bound_project_ref',o.bound_project_ref) END AS wire
FROM connector_result_private.ordinary_oauth_accounts o
JOIN public.site_connector_auth_attempts a ON (a.id,a.site_id,a.connector_id)=(o.authorization_id,o.site_id,o.connector_id)
JOIN public.connectors c ON (c.site_id,c.id,c.created_by,c.provider_id,c.toolkit_slug,c.provider_account_id,c.auth_config_id)=
  (a.site_id,a.connector_id,a.user_id,a.provider_id,a.toolkit_slug,a.provider_account_id,a.auth_config_id)
JOIN public.site_connector_providers p ON (p.id,p.site_id,p.project_id,p.credential_revision)=
  (c.provider_id,c.site_id,c.provider_project_id,a.credential_revision)
JOIN public.connector_policies cp ON (cp.connector_id,cp.site_id)=(c.id,c.site_id)
JOIN connector_result_private.direct_revisions d ON d.connector_id=c.id
LEFT JOIN public.site_secrets s ON s.site_id=c.site_id AND s.provider='composio' AND s.use_case='integrations' AND s.instance_id IS NULL
CROSS JOIN LATERAL (SELECT connector_result_private.business_screens(c.toolkit_slug,o.granted_scopes) AS known) screens
WHERE a.status='completed' AND a.supabase_project_ref IS NOT DISTINCT FROM o.bound_project_ref
  AND c.supabase_project_ref IS NOT DISTINCT FROM o.bound_project_ref
  AND CASE WHEN o.auth_scheme IS NULL THEN a.ask_on_connect AND screens.known IS NOT NULL
    WHEN o.auth_scheme='OAUTH2' THEN a.ask_on_connect AND c.toolkit_slug<>'supabase'
    ELSE o.auth_scheme='API_KEY' AND (o.bound_project_ref IS NOT NULL OR (a.ask_on_connect AND c.toolkit_slug<>'supabase')) END
  AND c.provider_account_id<>'instant_account' AND c.enabled AND c.verified_at IS NOT NULL AND c.provider_status='ACTIVE'
  AND NOT c.revocation_dispatched AND NOT c.revocation_pending AND p.status='active' AND p.provider='composio' AND p.provider_user_id=c.site_id::text
  AND c.granted_scopes @> o.granted_scopes AND c.granted_scopes <@ o.granted_scopes
  AND (CASE WHEN s.site_id IS NULL THEN p.credential_revision COLLATE "C" ~ '^platform:[a-f0-9]{64}$' ELSE
    s.is_active IS TRUE AND p.credential_revision=encode(sha256(convert_to(s.encrypted_value,'UTF8')),'hex') AND EXISTS (
      SELECT FROM connector_result_private.provider_attestations b WHERE
        (b.site_id,b.credential_revision,b.project_id)=(p.site_id,p.credential_revision,p.project_id)) END);

-- A normal scope/host/member policy edit is not another grant. But losing the
-- downstream account or changing its credential/scopes ends this new epoch,
-- even if someone later restores exactly the same strings (ABA).
CREATE FUNCTION connector_result_private.retire_customer_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME='connectors' THEN
    DELETE FROM connector_result_private.ordinary_oauth_accounts WHERE connector_id=NEW.id AND auth_scheme IS NOT NULL;
  ELSE
    DELETE FROM connector_result_private.ordinary_oauth_accounts o USING public.connectors c
      WHERE (c.site_id,c.id)=(o.site_id,o.connector_id) AND c.provider_id=NEW.id AND o.auth_scheme IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.retire_customer_account() FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
CREATE TRIGGER retire_customer_account AFTER UPDATE ON public.connectors FOR EACH ROW
  WHEN (NEW.revocation_pending OR NEW.revocation_dispatched OR NEW.verified_at IS NULL OR NEW.provider_status<>'ACTIVE'
    OR NOT (NEW.granted_scopes @> OLD.granted_scopes AND NEW.granted_scopes <@ OLD.granted_scopes))
  EXECUTE FUNCTION connector_result_private.retire_customer_account();
CREATE TRIGGER retire_customer_provider AFTER UPDATE ON public.site_connector_providers FOR EACH ROW
  WHEN (OLD.credential_revision IS DISTINCT FROM NEW.credential_revision OR (OLD.status='active' AND NEW.status<>'active'))
  EXECUTE FUNCTION connector_result_private.retire_customer_account();

CREATE FUNCTION connector_result_private.customer_slug(kit text,slug text,project_ref text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT starts_with(slug,upper(replace(kit,'-','_'))||'_') AND length(slug)<=150 AND NOT starts_with(slug,'COMPOSIO_')
    AND slug COLLATE "C" ~ '^[A-Z0-9]+(_[A-Z0-9]+)+$'
    AND (project_ref IS NULL OR substr(slug,length(kit)+2) COLLATE "C" ~ '^(GET|FETCH|RETRIEVE)_PROJECT(_(METADATA|DETAILS|STATUS))?$')
    AND regexp_replace(substr(slug,length(kit)+1),'_PROMOTION_CODE(_|$)','_COUPON\1','g') COLLATE "C"
      !~ '_(SQL|QUERY|ADMIN|IAM|RBAC|ROLE|ROLES|PERMISSION|PERMISSIONS|CREDENTIALS?|OAUTH|TOKENS?|SECRETS?|PROXY|EXECUTE|CODE|SHELL|SCRIPT|DEPLOY|WEBHOOK|WORKFLOW|RPC|RAW|GRAPHQL)(_|$)';
$$;

-- Old rows use exactly their original slug and scope gates. This is also
-- used for list/review discovery: selected mode needs at least one usable tool.
CREATE FUNCTION connector_result_private.account_tool_allowed(o connector_result_private.ordinary_accounts,slug text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN NOT (o.wire ? 'auth_scheme') THEN
    connector_result_private.ordinary_tool_allowed(o.toolkit_slug,o.tool_access_mode,o.allowed_tools,slug)
  WHEN slug IS NULL THEN o.tool_access_mode='all' OR (o.tool_access_mode='selected' AND EXISTS (
    SELECT FROM unnest(o.allowed_tools) t WHERE connector_result_private.customer_slug(o.toolkit_slug,t,o.wire->>'bound_project_ref')))
  ELSE connector_result_private.customer_slug(o.toolkit_slug,slug,o.wire->>'bound_project_ref') AND
    (o.tool_access_mode='all' OR (o.tool_access_mode='selected' AND slug=ANY(o.allowed_tools))) END;
$$;
REVOKE ALL ON FUNCTION connector_result_private.customer_slug(text,text,text),
  connector_result_private.account_tool_allowed(connector_result_private.ordinary_accounts,text)
  FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;

-- For an unknown screen profile, a single blocked screen means no admission;
-- do not guess a category from the toolkit, slug, or manager-supplied metadata.
CREATE OR REPLACE FUNCTION connector_result_private.ordinary_admissions(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_slug text)
RETURNS TABLE(connector_id uuid,authorization_id uuid,connector_revision integer,policy_revision integer,credential_revision text,direct_revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.connector_id,o.authorization_id,o.connector_revision,o.policy_revision,o.credential_revision,o.direct_revision
  FROM connector_result_private.instance_policy_accounts(p_site_id,p_user_id,p_connector_id,p_slug) a
  JOIN connector_result_private.ordinary_accounts o ON (o.connector_id,o.site_id)=(a.connector_id,p_site_id)
  WHERE connector_result_private.direct_actor(p_site_id,p_user_id,p_instance_id,p_agent_id)
    AND connector_result_private.account_tool_allowed(o,p_slug)
    AND NOT EXISTS (SELECT FROM public.site_members m WHERE (m.site_id,m.user_id)=(o.site_id,p_user_id)
      AND CASE WHEN o.required_screens=ARRAY['*'] THEN cardinality(m.blocked_screens) IS DISTINCT FROM 0
        ELSE m.blocked_screens && o.required_screens END);
$$;
CREATE OR REPLACE FUNCTION public.connector_support_agent_account_v2(p_site_id uuid,p_agent_id uuid,p_connector_id uuid,p_slug text)
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
      AND connector_result_private.account_tool_allowed(o,p_slug);
  IF jsonb_array_length(result)>1 THEN RAISE cardinality_violation; END IF;
  RETURN result;
END $$;

COMMIT;
