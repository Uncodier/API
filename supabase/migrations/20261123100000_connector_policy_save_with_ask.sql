BEGIN;
SET LOCAL lock_timeout = '5s';

-- No consent backfill: a historical assistant host (even with all tools) is not
-- proof of consent to generic execution. Preserve existing opt-outs and pending
-- or cancelled onboarding. Bind a deliberate new grant to its committing xact.
ALTER TABLE connector_result_private.direct_enrollments ADD COLUMN policy_grant_xid xid8;
ALTER TABLE connector_result_private.direct_turn_heads ADD COLUMN admission_snapshot pg_snapshot;

-- A site-wide head can exist before *this account's* grant (another account
-- enrolled, or revoke + re-enable with no intervening turn). A timestamp or
-- simple increasing xid comparison would admit turns started during a save.
-- Keep just the current head's MVCC snapshot, never a permanent per-turn log.
CREATE OR REPLACE FUNCTION connector_result_private.advance_direct_turn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('role',true) IN ('postgres','service_role','supabase_admin') OR
     (current_setting('role',true)='none' AND session_user=current_user) THEN
    IF EXISTS (SELECT FROM connector_result_private.direct_enrollments e WHERE e.site_id=NEW.site_id) THEN
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

-- The existing private write gate calls this after locking the head, proof,
-- connector and direct revision. Keep its ordinary member/host/tool/proof and
-- wall-clock expiry checks. A receipt read is NOT a new dispatch. No change to
-- its historical read checks, the journal, recovery provenance or replay key.
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
  IF c.id IS NULL AND EXISTS (SELECT FROM connector_result_private.direct_enrollments e
    WHERE e.connector_id=c.connector_id AND e.policy_grant_xid IS NOT NULL AND NOT EXISTS (
      SELECT FROM connector_result_private.direct_turn_heads h WHERE h.instance_id=c.instance_id AND h.action_id=c.request_id
        AND pg_visible_in_snapshot(e.policy_grant_xid,h.admission_snapshot))) THEN
    RAISE insufficient_privilege;
  END IF;
END $$;

-- New name and no defaults: legacy full saves remain incapable of creating
-- direct authority. The opt-out-only catalog RPC remains separate. Perform the
-- existing direct CAS first: it locks proof before connector, and consumes setup
-- intent before an account disable can invalidate it a second time. Both locks
-- and both audits belong to this transaction; a later error undoes both saves.
CREATE FUNCTION public.connector_save_policy_with_ask(
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
  direct_state := public.connector_set_direct_policy(p_site_id,p_actor_id,p_connector_id,p_expected_revision,
    p_expected_direct_revision,p_ask_enabled);
  IF p_catalog_reads IS NULL THEN
    receipt := public.connector_update_policy(p_site_id,p_connector_id,p_actor_id,p_expected_revision,p_allowed_tools,
      p_allowed_hosts,p_require_approval,p_enabled,p_tool_access_mode,p_support_publication);
  ELSE
    receipt := public.connector_update_policy(p_site_id,p_connector_id,p_actor_id,p_expected_revision,p_allowed_tools,
      p_allowed_hosts,p_require_approval,p_enabled,p_tool_access_mode,p_support_publication,p_catalog_reads);
  END IF;
  IF p_ask_enabled THEN
    UPDATE connector_result_private.direct_enrollments e SET policy_grant_xid=pg_current_xact_id()
      FROM connector_result_private.direct_bindings b WHERE (e.site_id,e.connector_id)=(p_site_id,p_connector_id)
        AND e.attestation_id=b.id AND b.expires_at>clock_timestamp();
    IF NOT FOUND THEN RAISE EXCEPTION 'Current resource isolation attestation required' USING ERRCODE='P0D01'; END IF;
  END IF;
  RETURN receipt || jsonb_build_object('direct_revision',(direct_state->>'direct_revision')::integer,'ask_enabled',p_ask_enabled);
END $$;
REVOKE ALL ON FUNCTION public.connector_save_policy_with_ask(uuid,uuid,uuid,integer,text[],text[],boolean,boolean,text,jsonb,boolean,boolean,integer)
  FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_save_policy_with_ask(uuid,uuid,uuid,integer,text[],text[],boolean,boolean,text,jsonb,boolean,boolean,integer)
  TO service_role;

COMMIT;