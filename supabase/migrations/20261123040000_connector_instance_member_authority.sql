BEGIN;
SET LOCAL lock_timeout = '5s';

-- Old claims (including in-flight reservations) and receipts were issued under
-- the intersection of the member and agent grants. In particular, a timed-out
-- agent grant need not have advanced *any* revision. Never reinterpret those
-- claims, or dispatch another operation on an already-running pre-cutover turn.
-- Mark the immutable, server-reserved Ask submission instead. PostgreSQL's
-- constant missing-column value for existing rows stays false after changing
-- the INSERT default. No journal scan, payload backfill, or policy epoch churn.
ALTER TABLE connector_result_private.direct_ask_submissions
  ADD COLUMN member_authority boolean NOT NULL DEFAULT false;
ALTER TABLE connector_result_private.direct_ask_submissions
  ALTER COLUMN member_authority SET DEFAULT true;

-- Only the generic private path uses this predicate. The prompt agent remains
-- a same-site active host (direct_actor), pinned to the trusted action at both
-- writes (lock_direct_write). It is not the human's connector-grant principal.
CREATE OR REPLACE FUNCTION connector_result_private.direct_admissions(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_slug text)
RETURNS TABLE(connector_id uuid,attestation_id uuid,connector_revision integer,policy_revision integer,credential_revision text,direct_revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.id,b.id,c.revision,cp.revision,b.credential_revision,d.direct_revision FROM connector_result_private.direct_bindings b
  JOIN connector_result_private.direct_revisions d ON d.connector_id=b.connector_id
  JOIN connector_result_private.direct_enrollments e ON e.attestation_id=b.id
  JOIN connector_result_private.direct_resources r ON (r.resource_namespace,r.resource_boundary,r.site_id)=(b.resource_namespace,b.resource_boundary,b.site_id)
  JOIN public.connectors c ON (c.site_id,c.id)=(b.site_id,b.connector_id)
  JOIN public.connector_policies cp ON (cp.site_id,cp.connector_id)=(c.site_id,c.id)
  LEFT JOIN public.connector_members m ON (m.site_id,m.connector_id,m.user_id)=(c.site_id,c.id,p_user_id)
  WHERE b.site_id=p_site_id AND (p_connector_id IS NULL OR b.connector_id=p_connector_id)
    AND connector_result_private.direct_actor(p_site_id,p_user_id,p_instance_id,p_agent_id)
    AND NOT EXISTS (SELECT FROM public.site_members sm WHERE (sm.site_id,sm.user_id)=(p_site_id,p_user_id)
      AND sm.blocked_screens && r.required_screens)
    AND 'assistant'=ANY(cp.allowed_hosts) AND (p_slug IS NULL OR (p_connector_id IS NOT NULL AND p_slug COLLATE "C" ~ '^[A-Z0-9][A-Z0-9_]{0,149}$'
      AND NOT starts_with(p_slug,'COMPOSIO_') AND starts_with(p_slug,upper(replace(c.toolkit_slug,'-','_')) || '_')))
    AND (cp.tool_access_mode='all' OR (cp.tool_access_mode='selected' AND CASE WHEN p_slug IS NULL THEN cardinality(cp.allowed_tools)>0
      ELSE p_slug=ANY(cp.allowed_tools) END))
    AND (CASE WHEN m.user_id IS NULL THEN c.access_mode='workspace' ELSE m.can_view AND m.can_use AND m.revoked_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) END);
$$;

-- The same exact, PK-indexed generation check covers reservation, storage
-- (including replay), and requester-only read/list. Old direct receipts become
-- unavailable at cutover; non-direct receipts use their unchanged predicate.
CREATE OR REPLACE FUNCTION connector_result_private.direct_claim_admitted(c connector_result_private.direct_claims) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.tool IS NOT NULL AND c.connector_id IS NOT NULL AND EXISTS (
    SELECT FROM connector_result_private.direct_ask_submissions s WHERE s.action_id=c.request_id AND s.member_authority
  ) AND EXISTS (
    SELECT FROM connector_result_private.direct_admissions(c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id,c.tool) a
    WHERE (a.connector_id,a.attestation_id,a.connector_revision,a.policy_revision,a.direct_revision,a.credential_revision) =
      (c.connector_id,c.attestation_id,c.connector_revision,c.policy_revision,c.direct_revision,c.credential_revision));
$$;

-- Retain wall-clock expiry *after* lock waits, for the two authorities that
-- can actually expire on this path: the credential proof and member grant.
CREATE OR REPLACE FUNCTION connector_result_private.check_direct_authority(c connector_result_private.direct_claims) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF connector_result_private.direct_claim_admitted(c) IS NOT TRUE OR NOT EXISTS (
    SELECT FROM connector_result_private.direct_attestations b WHERE b.id=c.attestation_id AND b.expires_at>clock_timestamp()
  ) OR EXISTS (SELECT FROM public.connector_members m WHERE (m.site_id,m.connector_id,m.user_id)=(c.site_id,c.connector_id,c.owner_id)
    AND m.expires_at<=clock_timestamp()) THEN
    RAISE insufficient_privilege;
  END IF;
END $$;

-- CREATE OR REPLACE retains the existing owners and private EXECUTE ACLs.
COMMIT;