BEGIN;
SET LOCAL lock_timeout = '5s';

-- One issuer-namespaced external resource belongs to one customer site. Many
-- accounts (including different toolkits) may point at that site's resource.
CREATE TABLE connector_result_private.direct_resources (
  resource_namespace text COLLATE "C" NOT NULL CHECK (resource_namespace ~ '^[a-z0-9][a-z0-9_.-]{0,99}$'),
  resource_boundary text COLLATE "C" NOT NULL CHECK (resource_boundary ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  -- Explicit even if empty. Native business restrictions relevant to this resource
  -- still apply (e.g. People/Leads on a CRM replica); unrelated screens do not.
  required_screens text[] NOT NULL CHECK (public.connector_valid_text_array(required_screens,32,'^[A-Za-z][A-Za-z0-9_-]{0,63}$')),
  PRIMARY KEY (resource_namespace,resource_boundary), UNIQUE(resource_namespace,resource_boundary,site_id)
);
CREATE INDEX direct_resources_site_idx ON connector_result_private.direct_resources(site_id);
ALTER TABLE connector_result_private.direct_resources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.direct_resources FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE FUNCTION connector_result_private.immutable_direct_resource() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'Revoke resource proofs before replacing the resource definition' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_direct_resource BEFORE UPDATE ON connector_result_private.direct_resources FOR EACH ROW
  EXECUTE FUNCTION connector_result_private.immutable_direct_resource();
REVOKE ALL ON FUNCTION connector_result_private.immutable_direct_resource() FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

-- Empty by design. No discovery flag, OAuth completion, workspace role, legacy
-- provider-project attestation or manager endpoint may create a resource proof.
-- An independent operator must verify the DOWNSTREAM credential, not merely the
-- Composio transport project. The provider must enforce the same site-exclusive
-- resource boundary for every action, argument, refresh and in-place reauth;
-- if a credential can escape that boundary or administer it, do not attest.
CREATE TABLE connector_result_private.direct_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL, connector_id uuid NOT NULL, provider_id uuid NOT NULL,
  project_id text COLLATE "C" NOT NULL, account_id text COLLATE "C" NOT NULL,
  auth_config_id text COLLATE "C" NOT NULL, toolkit_slug text COLLATE "C" NOT NULL,
  credential_revision text COLLATE "C" NOT NULL CHECK (credential_revision ~ '^(platform:)?[0-9a-f]{64}$'),
  resource_namespace text COLLATE "C" NOT NULL, resource_boundary text COLLATE "C" NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('external_business_resource','external_database_project')),
  -- For a bound database this is the independently verified local installation
  -- identity, NOT the remote project. The server also checks fresh gateway evidence.
  local_installation_ref text COLLATE "C" CHECK (local_installation_ref ~ '^[a-z]{20}$'),
  evidence_ref text COLLATE "C" NOT NULL CHECK (evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'),
  credential_custody text NOT NULL CHECK (credential_custody = 'customer_owned_dedicated'),
  resource_scope text NOT NULL CHECK (resource_scope = 'provider_enforced_single_site'),
  operation_scope text NOT NULL CHECK (operation_scope = 'business_data_only_no_control_plane'),
  rotation_scope text NOT NULL CHECK (rotation_scope = 'reauth_cannot_expand_boundary'),
  issued_by name NOT NULL DEFAULT current_user, issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  CHECK (isfinite(expires_at) AND expires_at > issued_at),
  CHECK (account_id <> 'instant_account'),
  CHECK (toolkit_slug <> 'supabase' OR resource_kind = 'external_database_project'),
  CHECK (CASE WHEN resource_kind = 'external_database_project' THEN local_installation_ref IS NOT NULL
    AND resource_boundary ~ '^[a-z]{20}$' AND resource_boundary <> local_installation_ref
    ELSE local_installation_ref IS NULL END),
  FOREIGN KEY (connector_id,site_id,provider_id,toolkit_slug,auth_config_id,account_id)
    REFERENCES public.connectors(id,site_id,provider_id,toolkit_slug,auth_config_id,provider_account_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id,site_id,project_id) REFERENCES public.site_connector_providers(id,site_id,project_id),
  FOREIGN KEY (resource_namespace,resource_boundary,site_id) REFERENCES connector_result_private.direct_resources(resource_namespace,resource_boundary,site_id),
  UNIQUE (id,site_id,connector_id)
);
CREATE UNIQUE INDEX direct_one_epoch_per_account ON connector_result_private.direct_attestations(connector_id) WHERE revoked_at IS NULL;
-- The partial index cannot find retired proofs during a parent deletion. Connector
-- and provider IDs are globally unique; no need to duplicate all six binding keys.
CREATE INDEX direct_attestations_connector_idx ON connector_result_private.direct_attestations(connector_id);
CREATE INDEX direct_attestations_provider_idx ON connector_result_private.direct_attestations(provider_id);
CREATE INDEX direct_attestations_resource_idx ON connector_result_private.direct_attestations(resource_namespace,resource_boundary,site_id);

CREATE TABLE connector_result_private.direct_enrollments (
  connector_id uuid PRIMARY KEY, site_id uuid NOT NULL, attestation_id uuid NOT NULL,
  enabled_by uuid NOT NULL REFERENCES auth.users(id), enabled_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (attestation_id,site_id,connector_id) REFERENCES connector_result_private.direct_attestations(id,site_id,connector_id) ON DELETE CASCADE
);
CREATE INDEX direct_enrollments_site_proof_idx ON connector_result_private.direct_enrollments(site_id,attestation_id,connector_id);
CREATE INDEX direct_enrollments_actor_idx ON connector_result_private.direct_enrollments(enabled_by);
-- Implicit revision 1 for untouched connectors. This row survives removal of a
-- proof or enrollment: clearing consent and re-enabling is never an ABA match.
CREATE TABLE connector_result_private.direct_revisions (
  connector_id uuid PRIMARY KEY REFERENCES public.connectors(id) ON DELETE CASCADE,
  direct_revision integer NOT NULL CHECK (direct_revision > 0)
);
-- The ordinary audit journal is unique per ordinary connector revision. Do not
-- take an ordinary revision (and invalidate legacy reports) to log direct consent.
CREATE TABLE connector_result_private.direct_policy_events (
  connector_id uuid NOT NULL REFERENCES public.connectors(id) ON DELETE CASCADE,
  direct_revision integer NOT NULL CHECK (direct_revision > 0), connector_revision integer NOT NULL CHECK (connector_revision > 0),
  actor_id uuid NOT NULL REFERENCES auth.users(id), enabled boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(connector_id,direct_revision)
);
CREATE INDEX direct_policy_events_actor_idx ON connector_result_private.direct_policy_events(actor_id);
ALTER TABLE connector_result_private.direct_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_result_private.direct_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_result_private.direct_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_result_private.direct_policy_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.direct_attestations, connector_result_private.direct_enrollments,
  connector_result_private.direct_revisions, connector_result_private.direct_policy_events
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

-- Only this private predicate models downstream authority. Local enabled state,
-- credential *contents* (ciphertext fingerprint), project ownership/identity,
-- BYOK withdrawal, revocation, expiry and database resource bindings stay current.
-- A platform Composio key is a transport credential only; its current env-derived
-- fingerprint and project are additionally verified by the server before use.
CREATE VIEW connector_result_private.direct_bindings AS
SELECT proof.* FROM connector_result_private.direct_attestations proof
JOIN public.connectors c ON (c.id,c.site_id,c.provider_id,c.provider_project_id,c.toolkit_slug,c.auth_config_id,c.provider_account_id) =
  (proof.connector_id,proof.site_id,proof.provider_id,proof.project_id,proof.toolkit_slug,proof.auth_config_id,proof.account_id)
JOIN public.site_connector_providers p ON (p.id,p.site_id,p.project_id,p.credential_revision) =
  (proof.provider_id,proof.site_id,proof.project_id,proof.credential_revision)
LEFT JOIN public.site_secrets s ON s.site_id=c.site_id AND s.provider='composio' AND s.use_case='integrations' AND s.instance_id IS NULL
WHERE proof.revoked_at IS NULL AND proof.expires_at > statement_timestamp()
  AND c.enabled AND c.verified_at IS NOT NULL AND NOT c.revocation_pending AND NOT c.revocation_dispatched AND c.provider_status='ACTIVE'
  AND p.status='active' AND p.provider='composio' AND p.provider_user_id=c.site_id::text
  AND (c.toolkit_slug <> 'supabase' OR c.supabase_project_ref IS NOT NULL)
  AND (c.supabase_project_ref IS NULL OR (proof.resource_kind='external_database_project' AND c.supabase_project_ref=proof.resource_boundary))
  AND (CASE WHEN s.site_id IS NULL THEN starts_with(p.credential_revision,'platform:') ELSE
    s.is_active IS TRUE AND p.credential_revision=encode(sha256(convert_to(s.encrypted_value,'UTF8')),'hex') AND EXISTS (
      SELECT FROM connector_result_private.provider_attestations b
      WHERE (b.site_id,b.credential_revision,b.project_id)=(p.site_id,p.credential_revision,p.project_id)) END);
REVOKE ALL ON connector_result_private.direct_bindings FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

CREATE FUNCTION connector_result_private.guard_direct_proof() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.id := gen_random_uuid(); NEW.issued_at := clock_timestamp(); NEW.issued_by := current_user;
    IF NEW.revoked_at IS NOT NULL THEN RAISE check_violation; END IF;
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND to_jsonb(NEW)-'revoked_at' = to_jsonb(OLD)-'revoked_at' THEN
    NEW.revoked_at := clock_timestamp();
  ELSE RAISE EXCEPTION 'A resource proof can only be revoked; issue a new epoch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_direct_proof BEFORE INSERT OR UPDATE ON connector_result_private.direct_attestations
  FOR EACH ROW EXECUTE FUNCTION connector_result_private.guard_direct_proof();

CREATE FUNCTION connector_result_private.direct_proof_changed() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- Keep the manager's optimistic concurrency token bound to the proof they saw.
  -- Reject even operator issuance against a stale, disabled or mismatched account.
  IF TG_OP='INSERT' AND NOT EXISTS (SELECT FROM connector_result_private.direct_bindings WHERE id=NEW.id) THEN
    RAISE EXCEPTION 'Exact current provider and resource binding required' USING ERRCODE='23514';
  END IF;
  -- Skip parent cascades. Serialize proof changes and manager CAS without
  -- touching the connector row or changing its ordinary revision/updated_at.
  INSERT INTO connector_result_private.direct_revisions AS d(connector_id,direct_revision)
    SELECT c.id,2 FROM public.connectors c WHERE c.id=coalesce(NEW.connector_id,OLD.connector_id)
    ON CONFLICT (connector_id) DO UPDATE SET direct_revision=d.direct_revision+1;
  RETURN NULL;
END $$;
CREATE TRIGGER direct_proof_changed AFTER INSERT OR UPDATE OR DELETE ON connector_result_private.direct_attestations
  FOR EACH ROW EXECUTE FUNCTION connector_result_private.direct_proof_changed();
REVOKE ALL ON FUNCTION connector_result_private.guard_direct_proof(), connector_result_private.direct_proof_changed()
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

CREATE FUNCTION public.connector_direct_policy(p_site_id uuid,p_actor_id uuid,p_connector_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' OR NOT EXISTS (
    SELECT FROM public.connector_effective_site_access(p_site_id,p_actor_id) a WHERE a.can_manage) THEN RAISE insufficient_privilege; END IF;
  SELECT jsonb_build_object('connector_id',c.id,'revision',c.revision,'direct_revision',coalesce(d.direct_revision,1),
      'attested',b.id IS NOT NULL,'enabled',e.attestation_id IS NOT NULL)
    INTO result FROM public.connectors c LEFT JOIN connector_result_private.direct_bindings b ON (b.site_id,b.connector_id)=(c.site_id,c.id)
    LEFT JOIN connector_result_private.direct_enrollments e ON e.attestation_id=b.id
    LEFT JOIN connector_result_private.direct_revisions d ON d.connector_id=c.id
    WHERE (c.site_id,c.id)=(p_site_id,p_connector_id);
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.connector_set_direct_policy(p_site_id uuid,p_actor_id uuid,p_connector_id uuid,
  p_expected_revision integer,p_expected_direct_revision integer,p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_revision integer; v_direct_revision integer; epoch uuid;
BEGIN
  -- Revocation/deletion already locks the proof before updating its epoch. Follow
  -- that order, including dormant enrollments, before locking the connector.
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' OR NOT EXISTS (
    SELECT FROM public.connector_effective_site_access(p_site_id,p_actor_id) a WHERE a.can_manage) THEN
    RAISE EXCEPTION 'Connector management denied' USING ERRCODE='42501'; END IF;
  PERFORM FROM connector_result_private.direct_attestations b WHERE (b.site_id,b.connector_id)=(p_site_id,p_connector_id)
    AND (b.revoked_at IS NULL OR EXISTS (SELECT FROM connector_result_private.direct_enrollments e
      WHERE e.connector_id=p_connector_id AND e.attestation_id=b.id)) ORDER BY b.id FOR SHARE;
  v_revision := public.connector_lock_for_manager(p_site_id,p_connector_id,p_actor_id,p_expected_revision);
  IF p_enabled IS NULL THEN RAISE invalid_parameter_value; END IF;
  INSERT INTO connector_result_private.direct_revisions(connector_id,direct_revision) VALUES (p_connector_id,1) ON CONFLICT DO NOTHING;
  UPDATE connector_result_private.direct_revisions SET direct_revision=direct_revision+1
    WHERE connector_id=p_connector_id AND direct_revision=p_expected_direct_revision RETURNING direct_revision INTO v_direct_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Direct revision conflict' USING ERRCODE='40001'; END IF;
  IF p_enabled THEN
    SELECT b.id INTO epoch FROM connector_result_private.direct_bindings b WHERE (b.site_id,b.connector_id)=(p_site_id,p_connector_id)
      AND b.expires_at>clock_timestamp();
    IF NOT FOUND THEN RAISE EXCEPTION 'Current resource isolation attestation required' USING ERRCODE='P0D01'; END IF;
    INSERT INTO connector_result_private.direct_enrollments(site_id,connector_id,attestation_id,enabled_by)
      VALUES (p_site_id,p_connector_id,epoch,p_actor_id) ON CONFLICT (connector_id) DO UPDATE SET
      attestation_id=EXCLUDED.attestation_id,enabled_by=EXCLUDED.enabled_by,enabled_at=clock_timestamp();
  ELSE DELETE FROM connector_result_private.direct_enrollments WHERE (site_id,connector_id)=(p_site_id,p_connector_id); END IF;
  INSERT INTO connector_result_private.direct_policy_events(connector_id,direct_revision,connector_revision,actor_id,enabled)
    VALUES (p_connector_id,v_direct_revision,v_revision,p_actor_id,p_enabled);
  RETURN public.connector_direct_policy(p_site_id,p_actor_id,p_connector_id);
END $$;
REVOKE ALL ON FUNCTION public.connector_direct_policy(uuid,uuid,uuid), public.connector_set_direct_policy(uuid,uuid,uuid,integer,integer,boolean)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_direct_policy(uuid,uuid,uuid), public.connector_set_direct_policy(uuid,uuid,uuid,integer,integer,boolean) TO service_role;

-- Not the legacy catalogue actor: unrelated hidden screens do not veto an
-- external isolated credential. The actual host/Connectors screens, site-wide
-- assignments, locations, membership and license remain gates, even for
-- managers. Direct use checks both grants below; this predicate alone is not a grant.
CREATE FUNCTION connector_result_private.direct_actor(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT FROM public.connector_effective_site_access(p_site_id,p_user_id) access
    JOIN public.sites s ON s.id=p_site_id AND s.archived_at IS NULL
    JOIN public.remote_instances i ON (i.id,i.site_id,i.user_id)=(p_instance_id,s.id,p_user_id) AND i.is_archived IS FALSE
    JOIN public.agents a ON (a.id,a.site_id)=(p_agent_id,s.id) AND a.status='active'
    WHERE access.can_view AND (s.user_id=p_user_id OR (EXISTS (
      SELECT FROM public.site_ownership o WHERE (o.site_id,o.user_id)=(s.id,p_user_id)) AND NOT EXISTS (
      SELECT FROM public.site_members m WHERE (m.site_id,m.user_id)=(s.id,p_user_id))) OR EXISTS (
      SELECT FROM public.site_members m WHERE (m.site_id,m.user_id)=(s.id,p_user_id) AND m.status='active'
        AND m.manually_disabled IS FALSE AND m.license_suspended IS FALSE AND m.restrict_to_assigned_only IS FALSE
        AND m.blocked_screens IS NOT NULL AND NOT (m.blocked_screens && ARRAY['aiWorkspace','connectors'])
        AND NOT EXISTS (SELECT FROM public.site_member_location_restrictions r WHERE (r.site_id,r.site_member_id)=(s.id,m.id)))));
$$;
REVOKE ALL ON FUNCTION connector_result_private.direct_actor(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE FUNCTION public.connector_direct_actor(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT current_setting('role',true)='service_role' AND connector_result_private.direct_actor(p_site_id,p_user_id,p_instance_id,p_agent_id);
$$;
REVOKE ALL ON FUNCTION public.connector_direct_actor(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_direct_actor(uuid,uuid,uuid,uuid) TO service_role;

-- One current check for discovery, exact dispatch and private-result handling.
-- The server separately proves nonanonymous private-interactive session provenance.
CREATE FUNCTION connector_result_private.direct_admissions(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_slug text)
RETURNS TABLE(connector_id uuid,attestation_id uuid,connector_revision integer,policy_revision integer,credential_revision text,direct_revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.id,b.id,c.revision,cp.revision,b.credential_revision,d.direct_revision FROM connector_result_private.direct_bindings b
  JOIN connector_result_private.direct_revisions d ON d.connector_id=b.connector_id
  JOIN connector_result_private.direct_enrollments e ON e.attestation_id=b.id
  JOIN connector_result_private.direct_resources r ON (r.resource_namespace,r.resource_boundary,r.site_id)=(b.resource_namespace,b.resource_boundary,b.site_id)
  JOIN public.connectors c ON (c.site_id,c.id)=(b.site_id,b.connector_id)
  JOIN public.connector_policies cp ON (cp.site_id,cp.connector_id)=(c.site_id,c.id)
  LEFT JOIN public.connector_members m ON (m.site_id,m.connector_id,m.user_id)=(c.site_id,c.id,p_user_id)
  LEFT JOIN public.connector_agents a ON (a.site_id,a.connector_id,a.agent_id)=(c.site_id,c.id,p_agent_id)
  WHERE b.site_id=p_site_id AND (p_connector_id IS NULL OR b.connector_id=p_connector_id)
    AND connector_result_private.direct_actor(p_site_id,p_user_id,p_instance_id,p_agent_id)
    AND NOT EXISTS (SELECT FROM public.site_members sm WHERE (sm.site_id,sm.user_id)=(p_site_id,p_user_id)
      AND sm.blocked_screens && r.required_screens)
    AND 'assistant'=ANY(cp.allowed_hosts) AND (p_slug IS NULL OR (p_connector_id IS NOT NULL AND p_slug COLLATE "C" ~ '^[A-Z0-9][A-Z0-9_]{0,149}$'
      AND NOT starts_with(p_slug,'COMPOSIO_') AND starts_with(p_slug,upper(replace(c.toolkit_slug,'-','_')) || '_')))
    AND (cp.tool_access_mode='all' OR (cp.tool_access_mode='selected' AND CASE WHEN p_slug IS NULL THEN cardinality(cp.allowed_tools)>0
      ELSE p_slug=ANY(cp.allowed_tools) END))
    AND (CASE WHEN m.user_id IS NULL THEN c.access_mode='workspace' ELSE m.can_view AND m.can_use AND m.revoked_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) END)
    AND (CASE WHEN a.agent_id IS NULL THEN c.access_mode='workspace' ELSE a.enabled AND a.revoked_at IS NULL
      AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp()) END);
$$;
REVOKE ALL ON FUNCTION connector_result_private.direct_admissions(uuid,uuid,uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

CREATE FUNCTION public.connector_direct_accounts(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_slug text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  SELECT coalesce(jsonb_agg(rowdata ORDER BY connector_id),'[]'::jsonb) INTO result FROM (
    SELECT ad.connector_id,jsonb_build_object('connector',to_jsonb(c),'provider',to_jsonb(p),
      'policy',jsonb_build_object('revision',cp.revision,'allowed_tools',cp.allowed_tools,'allowed_hosts',cp.allowed_hosts,
        'tool_access_mode',cp.tool_access_mode,'require_approval',cp.require_approval),
      'attestation_id',b.id,'direct_revision',ad.direct_revision,'resource_boundary',b.resource_boundary,
      'expires_at',b.expires_at,'local_installation_ref',b.local_installation_ref) AS rowdata
    FROM connector_result_private.direct_admissions(p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_slug) ad
    JOIN connector_result_private.direct_attestations b ON b.id=ad.attestation_id
    JOIN public.connectors c ON c.id=ad.connector_id JOIN public.site_connector_providers p ON p.id=c.provider_id
    JOIN public.connector_policies cp ON cp.connector_id=c.id ORDER BY c.id LIMIT 101) page;
  IF jsonb_array_length(result)>100 THEN RAISE EXCEPTION 'Narrow to an account' USING ERRCODE='P0D02'; END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.connector_direct_accounts(uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_direct_accounts(uuid,uuid,uuid,uuid,uuid,text) TO service_role;
COMMIT;