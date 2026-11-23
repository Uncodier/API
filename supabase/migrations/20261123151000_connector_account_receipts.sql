BEGIN;
SET LOCAL lock_timeout = '5s';

-- One journal and one uniqueness key across both provider authority kinds. A
-- completed authorization is not a resource attestation. Historical scoped
-- rows remain readable but cannot be inserted, updated, or consumed.
ALTER TABLE connector_result_private.direct_claims
  ADD COLUMN authorization_id uuid,
  DROP CONSTRAINT direct_claim_requires_attestation, DROP CONSTRAINT dispatch_authority_kind,
  ADD CONSTRAINT dispatch_authority_kind CHECK (
    num_nonnulls(authorization_id,attestation_id)=1 AND data_scope IS NULL AND source_name IS NULL
    AND project_ref IS NULL AND grant_id IS NULL) NOT VALID;
ALTER TABLE connector_direct_rpc.write_gate ADD COLUMN authorization_id uuid;
GRANT INSERT (authorization_id) ON connector_direct_rpc.write_gate TO service_role;
DROP TRIGGER a0_reject_retired_scoped ON connector_direct_rpc.write_gate;
CREATE TRIGGER a0_reject_retired_scoped BEFORE INSERT ON connector_direct_rpc.write_gate
  FOR EACH ROW WHEN (num_nonnulls(NEW.authorization_id,NEW.attestation_id)<>1 OR NEW.scoped_status IS NOT NULL
    OR NEW.data_scope IS NOT NULL OR NEW.source_name IS NOT NULL OR NEW.project_ref IS NOT NULL)
  EXECUTE FUNCTION connector_result_private.reject_retired_scoped_write();

-- Do not authorize an old turn retroactively, even one that was admitted
-- under a different connector or under the resource-proof path.
ALTER TABLE connector_result_private.direct_ask_submissions ADD COLUMN account_authority boolean NOT NULL DEFAULT false;
ALTER TABLE connector_result_private.direct_ask_submissions ALTER COLUMN account_authority SET DEFAULT true;

CREATE OR REPLACE FUNCTION connector_result_private.advance_direct_turn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('role',true) IN ('postgres','service_role','supabase_admin') OR
     (current_setting('role',true)='none' AND session_user=current_user) THEN
    IF EXISTS (SELECT FROM connector_result_private.direct_attestations b WHERE b.site_id=NEW.site_id
      AND b.revoked_at IS NULL AND b.expires_at>statement_timestamp() AND NOT connector_result_private.direct_disabled(b.connector_id)) OR EXISTS (
      -- Tracking a head is not an admission. Use the site index here; only
      -- the later exact-tool check consults the full private OAuth evidence.
      SELECT FROM connector_result_private.ordinary_oauth_accounts a WHERE a.site_id=NEW.site_id) THEN
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

-- The admission helper is shared with discovery. It rechecks the exact hosted
-- OAuth completion, provider credential, member policy and selected toolkit.
CREATE FUNCTION connector_result_private.account_claim_admitted(c connector_result_private.direct_claims) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.tool IS NOT NULL AND c.authorization_id IS NOT NULL AND c.attestation_id IS NULL AND c.data_scope IS NULL
    AND EXISTS (SELECT FROM connector_result_private.direct_ask_submissions s WHERE s.action_id=c.request_id AND s.account_authority)
    AND EXISTS (SELECT FROM connector_result_private.ordinary_admissions(c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id,c.tool) a
      WHERE (a.connector_id,a.authorization_id,a.connector_revision,a.policy_revision,a.direct_revision,a.credential_revision)=
        (c.connector_id,c.authorization_id,c.connector_revision,c.policy_revision,c.direct_revision,c.credential_revision));
$$;
REVOKE ALL ON FUNCTION connector_result_private.account_claim_admitted(connector_result_private.direct_claims)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

CREATE OR REPLACE FUNCTION connector_result_private.check_dispatch_authority(c connector_result_private.direct_claims) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF c.authorization_id IS NULL THEN PERFORM connector_result_private.check_direct_authority(c); RETURN; END IF;
  IF connector_result_private.account_claim_admitted(c) IS NOT TRUE OR EXISTS (SELECT FROM public.connector_members m
    WHERE (m.site_id,m.connector_id,m.user_id)=(c.site_id,c.connector_id,c.owner_id) AND m.expires_at<=clock_timestamp())
    OR NOT EXISTS (SELECT FROM connector_result_private.direct_revisions d JOIN connector_result_private.direct_turn_heads h
      ON (h.instance_id,h.site_id,h.action_id)=(c.instance_id,c.site_id,c.request_id)
      WHERE d.connector_id=c.connector_id AND pg_visible_in_snapshot(d.authority_xid,h.admission_snapshot)) THEN
    RAISE insufficient_privilege;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION connector_result_private.lock_direct_write(c connector_result_private.direct_claims) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id)=(c.instance_id,c.site_id,c.owner_id) FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM connector_result_private.direct_turn_heads h WHERE (h.instance_id,h.site_id,h.action_id)=(c.instance_id,c.site_id,c.request_id) FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM public.instance_logs l WHERE (l.id,l.site_id,l.user_id,l.instance_id)=(c.request_id,c.site_id,c.owner_id,c.instance_id)
    AND l.log_type='user_action' AND l.trusted_user_action AND l.agent_id=c.agent_id
    AND l.details->>'ask_request_sha256' COLLATE "C" ~ '^[a-f0-9]{64}$'
    AND EXISTS (SELECT FROM connector_result_private.direct_ask_submissions s WHERE s.action_id=l.id)
    AND l.details->>'status'='running' AND l.details @> '{"assistant_recovery":{"version":1,"respawnCount":0,"inFlight":true,"inFlightKind":"turn","execution":{"catalogUserSession":true,"callerSource":"interactive","executionMode":"direct"}}}'::jsonb
    AND NOT ((l.details->'assistant_recovery') ?| ARRAY['lease_token','conversationOnly'])
    AND NOT ((l.details #> '{assistant_recovery,execution}') ? 'instanceNodeId')
    AND coalesce(l.details #> '{assistant_recovery,execution,expectedResultsAmount}','1'::jsonb)='1'::jsonb
    AND coalesce(l.details #> '{assistant_recovery,execution,connectorIdHint}',to_jsonb(c.connector_id))=to_jsonb(c.connector_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  IF c.authorization_id IS NOT NULL THEN
    PERFORM FROM public.site_connector_auth_attempts a WHERE (a.id,a.site_id,a.connector_id)=(c.authorization_id,c.site_id,c.connector_id)
      AND a.status='completed' FOR SHARE;
  ELSE
    PERFORM FROM connector_result_private.direct_attestations b WHERE (b.id,b.site_id,b.connector_id)=(c.attestation_id,c.site_id,c.connector_id)
      AND b.revoked_at IS NULL FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM public.connectors k WHERE (k.id,k.site_id,k.revision)=(c.connector_id,c.site_id,c.connector_revision) FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM connector_result_private.direct_revisions d WHERE d.connector_id=c.connector_id AND d.direct_revision=c.direct_revision FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
END $$;

CREATE OR REPLACE FUNCTION connector_result_private.apply_direct_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '3s' AS $$
DECLARE c connector_result_private.direct_claims; incumbent uuid;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  c.site_id:=NEW.site_id; c.owner_id:=NEW.owner_id; c.instance_id:=NEW.instance_id; c.agent_id:=NEW.agent_id;
  c.connector_id:=NEW.connector_id; c.request_id:=NEW.request_id; c.tool:=NEW.tool; c.version:=NEW.version;
  c.schema_hash:=NEW.schema_hash; c.attestation_id:=NEW.attestation_id; c.connector_revision:=NEW.connector_revision;
  c.policy_revision:=NEW.policy_revision; c.direct_revision:=NEW.direct_revision; c.credential_revision:=NEW.credential_revision;
  c.authorization_id:=NEW.authorization_id;
  IF NEW.claim_id IS NULL AND NEW.report IS NULL THEN
    IF (c.version COLLATE "C" ~ '^[A-Za-z0-9_.-]{1,100}$' AND c.schema_hash COLLATE "C" ~ '^[a-f0-9]{64}$'
      AND NEW.arguments_digest COLLATE "C" ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE invalid_parameter_value; END IF;
    PERFORM connector_result_private.lock_direct_write(c);
    PERFORM connector_result_private.check_dispatch_authority(c);
    c.id:=gen_random_uuid(); c.arguments_digest:=NEW.arguments_digest; c.claimed_at:=clock_timestamp();
    INSERT INTO connector_result_private.direct_claims SELECT c.* ON CONFLICT(request_id,connector_id,tool,arguments_digest) DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch already reserved for this turn' USING ERRCODE='P0D03'; END IF;
    IF (SELECT count(*) FROM connector_result_private.direct_claims WHERE request_id=c.request_id)>100 THEN
      RAISE EXCEPTION 'Turn dispatch budget exceeded' USING ERRCODE='54000'; END IF;
    NEW.result_id:=c.id;
  ELSE
    IF NEW.arguments_digest IS NOT NULL OR NOT connector_result_private.valid_direct_report(NEW.report) THEN RAISE invalid_parameter_value; END IF;
    SELECT j.* INTO c FROM connector_result_private.direct_claims j WHERE j.id=NEW.claim_id AND
      (j.site_id,j.owner_id,j.instance_id,j.agent_id,j.connector_id,j.request_id,j.tool,j.version,j.schema_hash,
        j.connector_revision,j.policy_revision,j.direct_revision,j.credential_revision) =
      (NEW.site_id,NEW.owner_id,NEW.instance_id,NEW.agent_id,NEW.connector_id,NEW.request_id,NEW.tool,NEW.version,NEW.schema_hash,
        NEW.connector_revision,NEW.policy_revision,NEW.direct_revision,NEW.credential_revision) AND
      (j.attestation_id,j.authorization_id) IS NOT DISTINCT FROM
      (NEW.attestation_id,NEW.authorization_id);
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid dispatch reservation' USING ERRCODE='P0D04'; END IF;
    PERFORM connector_result_private.lock_direct_write(c);
    PERFORM pg_advisory_xact_lock(hashtextextended('connector-private-results:' || c.owner_id::text,0));
    SELECT j.* INTO c FROM connector_result_private.direct_claims j WHERE j.id=NEW.claim_id FOR UPDATE;
    IF NOT FOUND OR c.claimed_at<=clock_timestamp()-interval '1 hour' THEN
      RAISE EXCEPTION 'Stale dispatch reservation' USING ERRCODE='P0D04'; END IF;
    IF c.consumed_at IS NOT NULL THEN
      SELECT r.id INTO incumbent FROM connector_result_private.reports r WHERE r.direct_claim_id=c.id AND r.report=NEW.report
        AND r.expires_at>clock_timestamp() FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Receipt unavailable or different' USING ERRCODE='P0D04'; END IF;
      NEW.result_id:=incumbent;
    ELSE
      DELETE FROM connector_result_private.reports WHERE id IN (SELECT r.id FROM connector_result_private.reports r
        WHERE r.owner_id=c.owner_id ORDER BY r.created_at DESC,r.id OFFSET 19 LIMIT 1);
      UPDATE connector_result_private.direct_claims SET consumed_at=clock_timestamp() WHERE id=c.id;
      -- catalog=false: neither published-report choices nor legacy authorization
      -- apply. The referenced claim pins the original kind and exact authority.
      INSERT INTO connector_result_private.reports(site_id,owner_id,instance_id,agent_id,connector_id,tool,catalog,version,schema_hash,
        connector_revision,policy_revision,credential_revision,report,direct_claim_id) VALUES
        (c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id,c.tool,false,c.version,c.schema_hash,
        c.connector_revision,c.policy_revision,c.credential_revision,NEW.report,c.id) RETURNING id INTO NEW.result_id;
      DELETE FROM connector_result_private.reports WHERE id IN (SELECT r.id FROM connector_result_private.reports r
        WHERE r.expires_at<=statement_timestamp() ORDER BY r.expires_at LIMIT 100 FOR UPDATE SKIP LOCKED);
    END IF;
    PERFORM connector_result_private.check_dispatch_authority(c);
    IF c.claimed_at<=clock_timestamp()-interval '1 hour' OR NOT EXISTS (SELECT FROM connector_result_private.reports r
      WHERE r.id=NEW.result_id AND r.expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'Stale dispatch reservation' USING ERRCODE='P0D04'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION connector_result_private.direct_receipt_current(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT current_setting('role',true)='authenticated' AND auth.jwt()->'is_anonymous'='false'::jsonb AND EXISTS (
    SELECT FROM connector_result_private.reports r JOIN connector_result_private.direct_claims c ON c.id=r.direct_claim_id
    WHERE r.id=p_id AND r.owner_id=auth.uid() AND r.expires_at>statement_timestamp() AND c.consumed_at IS NOT NULL AND NOT r.catalog
      AND (r.site_id,r.owner_id,r.instance_id,r.agent_id,r.connector_id,r.tool,r.version,r.schema_hash,r.connector_revision,r.policy_revision,r.credential_revision)=
          (c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id,c.tool,c.version,c.schema_hash,c.connector_revision,c.policy_revision,c.credential_revision)
      AND CASE WHEN c.authorization_id IS NOT NULL THEN connector_result_private.account_claim_admitted(c)
        WHEN c.data_scope IS NULL THEN connector_result_private.direct_claim_admitted(c)
        ELSE connector_result_private.scoped_claim_admitted(c) END);
$$;

CREATE FUNCTION public.claim_connector_account_dispatch(
  p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_request_id uuid,
  p_tool text,p_version text,p_schema_hash text,p_authorization_id uuid,p_connector_revision integer,p_policy_revision integer,
  p_direct_revision integer,p_credential_revision text,p_arguments_digest text
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '3s' AS $$
DECLARE receipt uuid; previous_result text:=current_setting('connector_direct.result_id',true);
BEGIN
  IF current_user<>'service_role' OR current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  PERFORM set_config('connector_direct.result_id','',true);
  INSERT INTO connector_direct_rpc.write_gate(site_id,owner_id,instance_id,agent_id,connector_id,request_id,tool,version,schema_hash,
    authorization_id,connector_revision,policy_revision,direct_revision,credential_revision,arguments_digest) VALUES
    (p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_request_id,p_tool,p_version,p_schema_hash,
    p_authorization_id,p_connector_revision,p_policy_revision,p_direct_revision,p_credential_revision,p_arguments_digest);
  receipt:=nullif(current_setting('connector_direct.result_id'),'')::uuid;
  PERFORM set_config('connector_direct.result_id',coalesce(previous_result,''),true);
  IF receipt IS NULL THEN RAISE insufficient_privilege; END IF;
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.claim_connector_account_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,integer,integer,integer,text,text)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.claim_connector_account_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,integer,integer,integer,text,text) TO service_role;

CREATE FUNCTION public.store_connector_account_result(
  p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_request_id uuid,
  p_tool text,p_version text,p_schema_hash text,p_authorization_id uuid,p_connector_revision integer,p_policy_revision integer,
  p_direct_revision integer,p_credential_revision text,p_claim_id uuid,p_report jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '3s' AS $$
DECLARE receipt uuid; previous_result text:=current_setting('connector_direct.result_id',true);
BEGIN
  IF current_user<>'service_role' OR current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  PERFORM set_config('connector_direct.result_id','',true);
  INSERT INTO connector_direct_rpc.write_gate(site_id,owner_id,instance_id,agent_id,connector_id,request_id,tool,version,schema_hash,
    authorization_id,connector_revision,policy_revision,direct_revision,credential_revision,claim_id,report) VALUES
    (p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_request_id,p_tool,p_version,p_schema_hash,
    p_authorization_id,p_connector_revision,p_policy_revision,p_direct_revision,p_credential_revision,p_claim_id,p_report);
  receipt:=nullif(current_setting('connector_direct.result_id'),'')::uuid;
  PERFORM set_config('connector_direct.result_id',coalesce(previous_result,''),true);
  IF receipt IS NULL THEN RAISE insufficient_privilege; END IF;
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.store_connector_account_result(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,integer,integer,integer,text,uuid,jsonb)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.store_connector_account_result(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,integer,integer,integer,text,uuid,jsonb) TO service_role;

COMMIT;
