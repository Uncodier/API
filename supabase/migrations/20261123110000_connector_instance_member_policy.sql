BEGIN;
SET LOCAL lock_timeout = '5s';

-- Mark only new, server-reserved submissions. Historical claim/store/receipt
-- authority still requires the exact enrollment, not merely a current proof.
ALTER TABLE connector_result_private.direct_ask_submissions ADD COLUMN member_policy boolean NOT NULL DEFAULT false;
ALTER TABLE connector_result_private.direct_ask_submissions ALTER COLUMN member_policy SET DEFAULT true;

-- Track the committing transaction, not a wall-clock timestamp. A running
-- turn may not borrow a proof, re-grant or policy edit that committed later.
-- Existing proven accounts have no new epoch until the next change.
ALTER TABLE connector_result_private.direct_revisions ADD COLUMN authority_xid xid8;
-- Trusted action insertion is a hot path. Do not scan other tenants' proofs.
CREATE INDEX direct_attestations_active_site_idx ON connector_result_private.direct_attestations(site_id,expires_at,connector_id)
  WHERE revoked_at IS NULL;
CREATE FUNCTION connector_result_private.stamp_direct_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.authority_xid := pg_current_xact_id();
  RETURN NEW;
END $$;
CREATE TRIGGER stamp_direct_authority BEFORE INSERT OR UPDATE OF direct_revision ON connector_result_private.direct_revisions
  FOR EACH ROW EXECUTE FUNCTION connector_result_private.stamp_direct_authority();
-- Ordinary tool/host/member mutations already serialize on and advance the
-- connector revision. Stamp only an existing CAS row; never synthesize a grant.
CREATE FUNCTION connector_result_private.stamp_connector_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE connector_result_private.direct_revisions SET authority_xid=pg_current_xact_id() WHERE connector_id=NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER stamp_connector_policy AFTER UPDATE OF revision ON public.connectors
  FOR EACH ROW WHEN (OLD.revision IS DISTINCT FROM NEW.revision) EXECUTE FUNCTION connector_result_private.stamp_connector_policy();

-- A missing enrollment is ambiguous. Only the latest deliberate decision
-- (including disable-before-first-proof) can veto the current member policy.
-- Proof issue/revoke changes the CAS epoch but never clears this indexed veto.
CREATE FUNCTION connector_result_private.direct_disabled(p_connector_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce((SELECT NOT e.enabled FROM connector_result_private.direct_policy_events e
    WHERE e.connector_id=p_connector_id ORDER BY e.direct_revision DESC LIMIT 1),false);
$$;

-- One member/host/tool policy for the proven path and the deny-only RPC. A
-- workspace grant is inherited only in the absence of an override; a manager
-- or the provenance agent can neither lend nor replace the member's grant.
CREATE FUNCTION connector_result_private.instance_policy_accounts(p_site_id uuid,p_user_id uuid,p_connector_id uuid,p_slug text)
RETURNS TABLE(connector_id uuid,connector_revision integer,policy_revision integer)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.id,c.revision,cp.revision FROM public.connectors c
  JOIN public.connector_policies cp ON (cp.site_id,cp.connector_id)=(c.site_id,c.id)
  LEFT JOIN public.connector_members m ON (m.site_id,m.connector_id,m.user_id)=(c.site_id,c.id,p_user_id)
  WHERE c.site_id=p_site_id AND (p_connector_id IS NULL OR c.id=p_connector_id)
    AND c.enabled AND c.provider_status='ACTIVE' AND c.verified_at IS NOT NULL AND NOT c.revocation_pending AND NOT c.revocation_dispatched
    AND NOT connector_result_private.direct_disabled(c.id)
    AND 'assistant'=ANY(cp.allowed_hosts) AND (p_slug IS NULL OR (p_connector_id IS NOT NULL AND p_slug COLLATE "C" ~ '^[A-Z0-9][A-Z0-9_]{0,149}$'
      AND NOT starts_with(p_slug,'COMPOSIO_') AND starts_with(p_slug,upper(replace(c.toolkit_slug,'-','_')) || '_')))
    AND (cp.tool_access_mode='all' OR (cp.tool_access_mode='selected' AND CASE WHEN p_slug IS NULL THEN cardinality(cp.allowed_tools)>0
      ELSE p_slug=ANY(cp.allowed_tools) END))
    AND (CASE WHEN m.user_id IS NULL THEN c.access_mode='workspace' ELSE m.can_view AND m.can_use AND m.revoked_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) END);
$$;

CREATE OR REPLACE FUNCTION connector_result_private.direct_admissions(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_slug text)
RETURNS TABLE(connector_id uuid,attestation_id uuid,connector_revision integer,policy_revision integer,credential_revision text,direct_revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT b.connector_id,b.id,a.connector_revision,a.policy_revision,b.credential_revision,d.direct_revision
  FROM connector_result_private.direct_bindings b
  JOIN connector_result_private.direct_revisions d ON d.connector_id=b.connector_id
  JOIN connector_result_private.direct_resources r ON (r.resource_namespace,r.resource_boundary,r.site_id)=(b.resource_namespace,b.resource_boundary,b.site_id)
  JOIN connector_result_private.instance_policy_accounts(p_site_id,p_user_id,p_connector_id,p_slug) a ON a.connector_id=b.connector_id
  WHERE b.site_id=p_site_id AND connector_result_private.direct_actor(p_site_id,p_user_id,p_instance_id,p_agent_id)
    AND NOT EXISTS (SELECT FROM public.site_members sm WHERE (sm.site_id,sm.user_id)=(p_site_id,p_user_id)
      AND sm.blocked_screens && r.required_screens);
$$;

-- No generic authority, provider execution, data, or SQL grant from this RPC.
-- Callers may use ONLY a literal false as absence of this particular veto;
-- exact tool, credential/data scope and delivery require independent checks.
CREATE FUNCTION public.connector_instance_explicitly_disabled(p_site_id uuid,p_actor_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT EXISTS (SELECT FROM connector_result_private.instance_policy_accounts(p_site_id,p_actor_id,p_connector_id,NULL)
    WHERE current_setting('role',true)='service_role' AND p_connector_id IS NOT NULL
      AND connector_result_private.direct_actor(p_site_id,p_actor_id,p_instance_id,p_agent_id));
$$;

CREATE OR REPLACE FUNCTION connector_result_private.advance_direct_turn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('role',true) IN ('postgres','service_role','supabase_admin') OR
     (current_setting('role',true)='none' AND session_user=current_user) THEN
    IF EXISTS (SELECT FROM connector_result_private.direct_attestations b WHERE b.site_id=NEW.site_id
      AND b.revoked_at IS NULL AND b.expires_at>statement_timestamp() AND NOT connector_result_private.direct_disabled(b.connector_id)) THEN
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

CREATE OR REPLACE FUNCTION connector_result_private.direct_claim_admitted(c connector_result_private.direct_claims) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.tool IS NOT NULL AND c.connector_id IS NOT NULL AND EXISTS (
    SELECT FROM connector_result_private.direct_ask_submissions s WHERE s.action_id=c.request_id AND s.member_authority
      AND (s.member_policy OR EXISTS (SELECT FROM connector_result_private.direct_enrollments e
        WHERE (e.connector_id,e.attestation_id)=(c.connector_id,c.attestation_id)))
  ) AND EXISTS (
    SELECT FROM connector_result_private.direct_admissions(c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id,c.tool) a
    WHERE (a.connector_id,a.attestation_id,a.connector_revision,a.policy_revision,a.direct_revision,a.credential_revision) =
      (c.connector_id,c.attestation_id,c.connector_revision,c.policy_revision,c.direct_revision,c.credential_revision));
$$;

CREATE OR REPLACE FUNCTION connector_result_private.check_direct_authority(c connector_result_private.direct_claims) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF connector_result_private.direct_claim_admitted(c) IS NOT TRUE OR NOT EXISTS (
    SELECT FROM connector_result_private.direct_attestations b WHERE b.id=c.attestation_id AND b.expires_at>clock_timestamp()
  ) OR EXISTS (SELECT FROM public.connector_members m WHERE (m.site_id,m.connector_id,m.user_id)=(c.site_id,c.connector_id,c.owner_id)
    AND m.expires_at<=clock_timestamp()) THEN
    RAISE insufficient_privilege;
  END IF;
  -- New claims have no id until after admission. Store/replay must use the
  -- exact previously reserved revision tuple and cannot mint another claim.
  IF c.id IS NULL AND EXISTS (SELECT FROM connector_result_private.direct_revisions d
    WHERE d.connector_id=c.connector_id AND d.authority_xid IS NOT NULL AND NOT EXISTS (
      SELECT FROM connector_result_private.direct_turn_heads h WHERE h.instance_id=c.instance_id AND h.action_id=c.request_id
        AND pg_visible_in_snapshot(d.authority_xid,h.admission_snapshot))) THEN
    RAISE insufficient_privilege;
  END IF;
  IF c.id IS NULL AND EXISTS (SELECT FROM connector_result_private.direct_enrollments e
    WHERE e.connector_id=c.connector_id AND e.policy_grant_xid IS NOT NULL AND NOT EXISTS (
      SELECT FROM connector_result_private.direct_turn_heads h WHERE h.instance_id=c.instance_id AND h.action_id=c.request_id
        AND pg_visible_in_snapshot(e.policy_grant_xid,h.admission_snapshot))) THEN
    RAISE insufficient_privilege;
  END IF;
END $$;

-- Preserve strict legacy status shapes, but never tell an older manager UI that
-- an account is Off while member-policy authorization is actually effective.
CREATE OR REPLACE FUNCTION public.connector_direct_policy(p_site_id uuid,p_actor_id uuid,p_connector_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' OR NOT EXISTS (
    SELECT FROM public.connector_effective_site_access(p_site_id,p_actor_id) a WHERE a.can_manage) THEN RAISE insufficient_privilege; END IF;
  SELECT jsonb_build_object('connector_id',c.id,'revision',c.revision,'direct_revision',coalesce(d.direct_revision,1),
      'attested',b.id IS NOT NULL,'enabled',b.id IS NOT NULL AND NOT connector_result_private.direct_disabled(c.id))
    INTO result FROM public.connectors c LEFT JOIN connector_result_private.direct_bindings b ON (b.site_id,b.connector_id)=(c.site_id,c.id)
    LEFT JOIN connector_result_private.direct_revisions d ON d.connector_id=c.id
    WHERE (c.site_id,c.id)=(p_site_id,p_connector_id);
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.connector_instance_policy_status(p_site_id uuid,p_actor_id uuid,p_connector_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.connector_ask_policy_status(p_site_id,p_actor_id,p_connector_id) ||
    jsonb_build_object('authorization_mode','member_policy','explicitly_disabled',connector_result_private.direct_disabled(p_connector_id));
$$;
REVOKE ALL ON FUNCTION connector_result_private.stamp_direct_authority(),connector_result_private.stamp_connector_policy(),
  connector_result_private.direct_disabled(uuid),connector_result_private.instance_policy_accounts(uuid,uuid,uuid,text),
  public.connector_instance_policy_status(uuid,uuid,uuid),public.connector_instance_explicitly_disabled(uuid,uuid,uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_instance_policy_status(uuid,uuid,uuid),public.connector_instance_explicitly_disabled(uuid,uuid,uuid,uuid,uuid)
  TO service_role;
COMMIT;
