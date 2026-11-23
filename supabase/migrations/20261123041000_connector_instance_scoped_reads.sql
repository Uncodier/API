BEGIN;
SET LOCAL lock_timeout = '5s';

-- Local authority only. The host must independently establish that this exact
-- bound project is the current installation and run only its bounded native
-- analytics compiler. This migration neither executes SQL from a caller nor
-- reads business tables. No enrollment, new platform grant or policy backfill.
CREATE FUNCTION connector_result_private.scoped_read_admission(site uuid, actor uuid, parent uuid, agent uuid, account uuid)
RETURNS TABLE(connector_id uuid, connector_revision integer, policy_revision integer, direct_revision integer,
  credential_revision text, project_ref text) LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.id,c.revision,cp.revision,coalesce(d.direct_revision,1),p.credential_revision,c.supabase_project_ref
  FROM public.connectors c JOIN public.connector_policies cp ON (cp.connector_id,cp.site_id)=(c.id,c.site_id)
  JOIN public.site_connector_providers p ON (p.id,p.site_id,p.project_id)=(c.provider_id,c.site_id,c.provider_project_id)
  LEFT JOIN connector_result_private.direct_revisions d ON d.connector_id=c.id
  LEFT JOIN public.connector_members m ON (m.connector_id,m.site_id,m.user_id)=(c.id,c.site_id,actor)
  LEFT JOIN public.site_secrets s ON s.site_id=c.site_id AND s.provider='composio' AND s.use_case='integrations' AND s.instance_id IS NULL
  WHERE (c.id,c.site_id)=(account,site) AND c.toolkit_slug='supabase' AND c.supabase_project_ref COLLATE "C" ~ '^[a-z]{20}$'
    AND c.enabled AND c.verified_at IS NOT NULL AND c.provider_status='ACTIVE' AND c.provider_account_id<>'instant_account'
    AND NOT c.revocation_pending AND NOT c.revocation_dispatched AND p.status='active' AND p.provider='composio' AND p.provider_user_id=site::text
    AND CASE WHEN s.site_id IS NULL THEN p.credential_revision COLLATE "C" ~ '^platform:[a-f0-9]{64}$' ELSE
      s.is_active AND p.credential_revision=encode(sha256(convert_to(s.encrypted_value,'UTF8')),'hex') AND EXISTS (
        SELECT FROM connector_result_private.provider_attestations b WHERE (b.site_id,b.credential_revision,b.project_id)=(site,p.credential_revision,p.project_id)) END
    AND public.site_user_has_effective_access(site,actor) AND connector_result_private.direct_actor(site,actor,parent,agent)
    -- A current third-party isolation proof explicitly classifies this account
    -- as external, conflicting with the required local installation evidence.
    AND NOT EXISTS (SELECT FROM connector_result_private.direct_attestations b WHERE b.connector_id=c.id
      AND b.resource_kind='external_database_project' AND b.revoked_at IS NULL AND b.expires_at>statement_timestamp())
    AND cp.catalog_reads AND 'assistant'=ANY(cp.allowed_hosts) AND (cp.tool_access_mode='all' OR
      (cp.tool_access_mode='selected' AND 'SUPABASE_RUN_READ_ONLY_QUERY'=ANY(cp.allowed_tools)))
    AND CASE WHEN m.user_id IS NULL THEN c.access_mode='workspace' ELSE m.can_view AND m.can_use AND m.revoked_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) END
    AND coalesce((SELECT e.enabled FROM connector_result_private.direct_policy_events e WHERE e.connector_id=c.id
      ORDER BY e.direct_revision DESC LIMIT 1),true);
$$;

-- A separate prospective head: an unenrolled site cannot gain a generic
-- direct turn, and a deleted or unkeyed newer action cannot revive this one.
CREATE TABLE connector_result_private.scoped_turn_heads (LIKE connector_result_private.direct_turn_heads INCLUDING ALL,
  FOREIGN KEY (instance_id) REFERENCES public.remote_instances(id) ON DELETE CASCADE);
ALTER TABLE connector_result_private.scoped_turn_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.scoped_turn_heads FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE FUNCTION connector_result_private.advance_scoped_turn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (current_setting('role',true) IN ('postgres','service_role','supabase_admin') OR
      (current_setting('role',true)='none' AND session_user=current_user)) AND (EXISTS (
    SELECT FROM public.connectors c WHERE c.site_id=NEW.site_id AND c.toolkit_slug='supabase' AND c.supabase_project_ref IS NOT NULL)
    OR EXISTS (SELECT FROM connector_result_private.scoped_turn_heads h WHERE h.instance_id=NEW.instance_id)) THEN
    INSERT INTO connector_result_private.scoped_turn_heads AS h(instance_id,site_id,action_id,action_created_at)
    VALUES (NEW.instance_id,NEW.site_id,NEW.id,NEW.created_at) ON CONFLICT (instance_id) DO UPDATE SET
      site_id=EXCLUDED.site_id,action_id=EXCLUDED.action_id,action_created_at=EXCLUDED.action_created_at
    WHERE (h.action_created_at,h.action_id)<(EXCLUDED.action_created_at,EXCLUDED.action_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER connector_scoped_turn_advance AFTER INSERT ON public.instance_logs FOR EACH ROW
  WHEN (NEW.log_type='user_action' AND NEW.trusted_user_action) EXECUTE FUNCTION connector_result_private.advance_scoped_turn();

-- Reuse the immutable dispatch digest/turn budget, replay/expiry, owner
-- retention lock and requester RLS gate. Exactly one authority kind per claim.
ALTER TABLE connector_result_private.direct_claims ALTER COLUMN attestation_id DROP NOT NULL,
  ADD COLUMN data_scope text, ADD COLUMN source_name text, ADD COLUMN project_ref text, ADD COLUMN grant_id uuid,
  ADD CONSTRAINT dispatch_authority_kind CHECK (
    (attestation_id IS NOT NULL AND data_scope IS NULL AND source_name IS NULL AND project_ref IS NULL AND grant_id IS NULL) OR
    (attestation_id IS NULL AND tool='SUPABASE_RUN_READ_ONLY_QUERY' AND source_name IS NOT NULL AND project_ref IS NOT NULL
      AND project_ref COLLATE "C" ~ '^[a-z]{20}$' AND source_name IN ('paid_sales','tender_awards','approved_orders') AND data_scope IS NOT NULL
      AND ((data_scope='workspace' AND grant_id IS NULL) OR (data_scope='platform' AND grant_id IS NOT NULL)))) NOT VALID;
-- Old rows necessarily satisfied the direct branch (attestation_id was NOT NULL).
-- All new writes are checked; validate the historical journal separately in an
-- approved, time-bounded maintenance window rather than scanning it at cutover.
ALTER TABLE connector_direct_rpc.write_gate ADD COLUMN data_scope text, ADD COLUMN source_name text, ADD COLUMN project_ref text,
  ADD COLUMN scoped_status boolean;
GRANT INSERT (data_scope,source_name,project_ref,scoped_status) ON connector_direct_rpc.write_gate TO service_role;

CREATE FUNCTION connector_result_private.scoped_claim_admitted(c connector_result_private.direct_claims) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.tool='SUPABASE_RUN_READ_ONLY_QUERY' AND c.attestation_id IS NULL AND c.source_name IN ('paid_sales','tender_awards','approved_orders')
    AND EXISTS (SELECT FROM connector_result_private.direct_ask_submissions s WHERE s.action_id=c.request_id AND s.member_authority)
    AND EXISTS (SELECT FROM connector_result_private.scoped_read_admission(c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id) a
      WHERE (a.project_ref,a.connector_revision,a.policy_revision,a.direct_revision,a.credential_revision)=
        (c.project_ref,c.connector_revision,c.policy_revision,c.direct_revision,c.credential_revision))
    AND NOT EXISTS (SELECT FROM public.site_members sm WHERE (sm.site_id,sm.user_id)=(c.site_id,c.owner_id)
      AND (sm.blocked_screens IS NULL OR sm.blocked_screens && CASE c.source_name
        WHEN 'paid_sales' THEN ARRAY['sales','pos','reportSales'] WHEN 'tender_awards' THEN ARRAY['procurementApprovals','procurementTenders','purchasesQuotes']
        ELSE ARRAY['procurementApprovals','procurementTenders','purchasesQuotes','purchasesOrders'] END))
    AND connector_result_private.analytics_permitted(c.site_id,c.owner_id,c.connector_id,c.agent_id,c.project_ref,c.data_scope,c.source_name,c.grant_id);
$$;

-- Common trusted turn proof, not a second connector-agent grant. Distinct
-- heads and proof locks preserve the old direct path even on a mixed site.
CREATE OR REPLACE FUNCTION connector_result_private.lock_direct_write(c connector_result_private.direct_claims) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id)=(c.instance_id,c.site_id,c.owner_id) FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  IF c.data_scope IS NULL THEN
    PERFORM FROM connector_result_private.direct_turn_heads h WHERE (h.instance_id,h.site_id,h.action_id)=(c.instance_id,c.site_id,c.request_id) FOR SHARE;
  ELSE
    PERFORM FROM connector_result_private.scoped_turn_heads h WHERE (h.instance_id,h.site_id,h.action_id)=(c.instance_id,c.site_id,c.request_id) FOR SHARE;
  END IF;
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
  IF c.data_scope IS NULL THEN
    PERFORM FROM connector_result_private.direct_attestations b WHERE (b.id,b.site_id,b.connector_id)=(c.attestation_id,c.site_id,c.connector_id)
      AND b.revoked_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  END IF;
  PERFORM FROM public.connectors k WHERE (k.id,k.site_id,k.revision)=(c.connector_id,c.site_id,c.connector_revision) FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  IF c.data_scope IS NOT NULL AND NOT EXISTS (SELECT FROM connector_result_private.direct_revisions d WHERE d.connector_id=c.connector_id) THEN
    -- The ordinary connector lock serializes manager changes, but an operator
    -- proof trigger can insert the first direct revision without updating it.
    -- Materialize only the default (no consent, setup intent or enrollment).
    -- Its PK conflict/row lock serializes that first epoch with this admission.
    INSERT INTO connector_result_private.direct_revisions(connector_id,direct_revision) VALUES (c.connector_id,1) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM FROM connector_result_private.direct_revisions d WHERE d.connector_id=c.connector_id AND d.direct_revision=c.direct_revision FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
END $$;

CREATE FUNCTION connector_result_private.check_dispatch_authority(c connector_result_private.direct_claims) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF c.data_scope IS NULL THEN PERFORM connector_result_private.check_direct_authority(c); RETURN; END IF;
  IF connector_result_private.scoped_claim_admitted(c) IS NOT TRUE OR EXISTS (SELECT FROM public.connector_members m
    WHERE (m.site_id,m.connector_id,m.user_id)=(c.site_id,c.connector_id,c.owner_id) AND m.expires_at<=clock_timestamp()) OR
    (c.data_scope='platform' AND NOT EXISTS (SELECT FROM connector_result_private.analytics_grants g WHERE g.id=c.grant_id
      AND g.expires_at>clock_timestamp() AND g.revoked_at IS NULL FOR SHARE)) THEN RAISE insufficient_privilege; END IF;
END $$;

-- The legacy write RPCs never populate scope/source/project. Conversely, the
-- scoped RPC cannot supply an attestation, slug, grant UUID, SQL or table name.
CREATE OR REPLACE FUNCTION connector_result_private.apply_direct_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '3s' AS $$
DECLARE c connector_result_private.direct_claims; incumbent uuid;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  IF NEW.scoped_status IS TRUE THEN
    PERFORM set_config('connector_scoped.status',(SELECT to_jsonb(a)::text FROM connector_result_private.scoped_read_admission(
      NEW.site_id,NEW.owner_id,NEW.instance_id,NEW.agent_id,NEW.connector_id) a),true);
    IF nullif(current_setting('connector_scoped.status',true),'') IS NULL THEN RETURN NULL; END IF;
    NEW.result_id:=NEW.connector_id; RETURN NEW; -- z_authorize still checks actual authenticated RLS.
  END IF;
  c.site_id:=NEW.site_id; c.owner_id:=NEW.owner_id; c.instance_id:=NEW.instance_id; c.agent_id:=NEW.agent_id;
  c.connector_id:=NEW.connector_id; c.request_id:=NEW.request_id; c.tool:=NEW.tool; c.version:=NEW.version;
  c.schema_hash:=NEW.schema_hash; c.attestation_id:=NEW.attestation_id; c.connector_revision:=NEW.connector_revision;
  c.policy_revision:=NEW.policy_revision; c.direct_revision:=NEW.direct_revision; c.credential_revision:=NEW.credential_revision;
  c.project_ref:=NEW.project_ref; c.source_name:=NEW.source_name; c.data_scope:=NEW.data_scope;
  IF NEW.claim_id IS NULL AND NEW.report IS NULL THEN
    IF (c.version COLLATE "C" ~ '^[A-Za-z0-9_.-]{1,100}$' AND c.schema_hash COLLATE "C" ~ '^[a-f0-9]{64}$'
      AND NEW.arguments_digest COLLATE "C" ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE invalid_parameter_value; END IF;
    PERFORM connector_result_private.lock_direct_write(c);
    IF c.data_scope IS NOT NULL AND c.version IS DISTINCT FROM '20261116_00' THEN RAISE insufficient_privilege; END IF;
    IF c.data_scope='platform' THEN
      SELECT g.id INTO c.grant_id FROM connector_result_private.analytics_grants g WHERE
        (g.site_id,g.user_id,g.connector_id,g.agent_id,g.project_ref)=(c.site_id,c.owner_id,c.connector_id,c.agent_id,c.project_ref)
        AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() FOR SHARE;
    END IF;
    PERFORM connector_result_private.check_dispatch_authority(c);
    c.id:=gen_random_uuid(); c.arguments_digest:=NEW.arguments_digest; c.claimed_at:=clock_timestamp();
    INSERT INTO connector_result_private.direct_claims SELECT c.* ON CONFLICT(request_id,connector_id,tool,arguments_digest) DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch already reserved for this turn' USING ERRCODE='P0D03'; END IF;
    IF (SELECT count(*) FROM connector_result_private.direct_claims WHERE request_id=c.request_id)>100 THEN
      RAISE EXCEPTION 'Turn dispatch budget exceeded' USING ERRCODE='54000'; END IF;
    NEW.result_id:=c.id;
  ELSE
    IF NEW.arguments_digest IS NOT NULL OR NOT connector_result_private.valid_direct_report(NEW.report) THEN RAISE invalid_parameter_value; END IF;
    IF c.data_scope IS NOT NULL AND (jsonb_array_length(NEW.report->'rows')>25 OR EXISTS (
      SELECT FROM jsonb_array_elements_text(NEW.report->'columns') col WHERE col COLLATE "C" !~ '^[a-z][a-z0-9_]{0,47}$') OR EXISTS (
      SELECT FROM jsonb_array_elements(NEW.report->'rows') r, jsonb_array_elements_text(r) v WHERE octet_length(v)>200)) THEN
      RAISE invalid_parameter_value;
    END IF;
    SELECT j.* INTO c FROM connector_result_private.direct_claims j WHERE j.id=NEW.claim_id AND
      (j.site_id,j.owner_id,j.instance_id,j.agent_id,j.connector_id,j.request_id,j.tool,j.version,j.schema_hash,
        j.connector_revision,j.policy_revision,j.direct_revision,j.credential_revision) =
      (NEW.site_id,NEW.owner_id,NEW.instance_id,NEW.agent_id,NEW.connector_id,NEW.request_id,NEW.tool,NEW.version,NEW.schema_hash,
        NEW.connector_revision,NEW.policy_revision,NEW.direct_revision,NEW.credential_revision) AND
      (j.attestation_id,j.data_scope,j.source_name,j.project_ref) IS NOT DISTINCT FROM
      (NEW.attestation_id,NEW.data_scope,NEW.source_name,NEW.project_ref);
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
      -- apply. Scope/source/grant are immutable on the referenced private claim.
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

-- Same marker/receipt/owner/parent visibility; choose the original authority,
-- never OR the two admissions together. A later turn does not erase history.
CREATE OR REPLACE FUNCTION connector_result_private.direct_receipt_current(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT current_setting('role',true)='authenticated' AND auth.jwt()->'is_anonymous'='false'::jsonb AND EXISTS (
    SELECT FROM connector_result_private.reports r JOIN connector_result_private.direct_claims c ON c.id=r.direct_claim_id
    WHERE r.id=p_id AND r.owner_id=auth.uid() AND r.expires_at>statement_timestamp() AND c.consumed_at IS NOT NULL AND NOT r.catalog
      AND (r.site_id,r.owner_id,r.instance_id,r.agent_id,r.connector_id,r.tool,r.version,r.schema_hash,r.connector_revision,r.policy_revision,r.credential_revision)=
          (c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id,c.tool,c.version,c.schema_hash,c.connector_revision,c.policy_revision,c.credential_revision)
      AND CASE WHEN c.data_scope IS NULL THEN connector_result_private.direct_claim_admitted(c)
        ELSE connector_result_private.scoped_claim_admitted(c) END);
$$;

CREATE FUNCTION public.connector_instance_scoped_read(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb; prev text:=current_setting('connector_scoped.status',true); ack text:=current_setting('connector_direct.result_id',true);
BEGIN
  IF current_user<>'service_role' OR current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  BEGIN
    PERFORM set_config('connector_scoped.status','',true),set_config('connector_direct.result_id','',true);
    INSERT INTO connector_direct_rpc.write_gate(site_id,owner_id,instance_id,agent_id,connector_id,scoped_status)
      VALUES (p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,true);
    IF nullif(current_setting('connector_direct.result_id'),'')::uuid=p_connector_id THEN result:=current_setting('connector_scoped.status')::jsonb; END IF;
    PERFORM set_config('connector_scoped.status',coalesce(prev,''),true),set_config('connector_direct.result_id',coalesce(ack,''),true);
  EXCEPTION WHEN insufficient_privilege THEN RETURN NULL; END;
  RETURN result;
END $$;

CREATE FUNCTION connector_direct_rpc.scoped_write(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_request_id uuid,
  p_connector_revision integer,p_policy_revision integer,p_direct_revision integer,p_credential_revision text,p_project_ref text,
  p_version text,p_schema_hash text,p_source text,p_data_scope text,p_arguments_digest text,p_claim_id uuid,p_report jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '3s' AS $$
DECLARE result uuid; prev text:=current_setting('connector_direct.result_id',true);
BEGIN
  IF current_user<>'service_role' OR current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  IF (p_data_scope IN ('workspace','platform') AND p_source IN ('paid_sales','tender_awards','approved_orders')) IS NOT TRUE THEN RAISE insufficient_privilege; END IF;
  PERFORM set_config('connector_direct.result_id','',true);
  INSERT INTO connector_direct_rpc.write_gate(site_id,owner_id,instance_id,agent_id,connector_id,request_id,tool,connector_revision,policy_revision,
    direct_revision,credential_revision,version,schema_hash,project_ref,source_name,data_scope,arguments_digest,claim_id,report) VALUES
    (p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_request_id,'SUPABASE_RUN_READ_ONLY_QUERY',p_connector_revision,p_policy_revision,
    p_direct_revision,p_credential_revision,p_version,p_schema_hash,p_project_ref,p_source,p_data_scope,p_arguments_digest,p_claim_id,p_report);
  result:=nullif(current_setting('connector_direct.result_id'),'')::uuid;
  PERFORM set_config('connector_direct.result_id',coalesce(prev,''),true);
  IF result IS NULL THEN RAISE insufficient_privilege; END IF;
  RETURN result;
END $$;
CREATE FUNCTION public.claim_connector_instance_scoped_read(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_request_id uuid,
  p_connector_revision integer,p_policy_revision integer,p_direct_revision integer,p_credential_revision text,p_project_ref text,
  p_version text,p_schema_hash text,p_source text,p_data_scope text,p_arguments_digest text)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT connector_direct_rpc.scoped_write($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL,NULL);
$$;
CREATE FUNCTION public.store_connector_instance_scoped_read(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_request_id uuid,
  p_connector_revision integer,p_policy_revision integer,p_direct_revision integer,p_credential_revision text,p_project_ref text,
  p_version text,p_schema_hash text,p_source text,p_data_scope text,p_claim_id uuid,p_report jsonb)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT connector_direct_rpc.scoped_write($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NULL,$16,$17);
$$;

REVOKE ALL ON FUNCTION connector_result_private.scoped_read_admission(uuid,uuid,uuid,uuid,uuid),connector_result_private.advance_scoped_turn(),
  connector_result_private.scoped_claim_admitted(connector_result_private.direct_claims),connector_result_private.check_dispatch_authority(connector_result_private.direct_claims),
  public.connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid),connector_direct_rpc.scoped_write(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,text,uuid,jsonb),
  public.claim_connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,text),
  public.store_connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,uuid,jsonb)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid),
  connector_direct_rpc.scoped_write(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,text,uuid,jsonb),
  public.claim_connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,text),
  public.store_connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,uuid,jsonb) TO service_role;
COMMIT;