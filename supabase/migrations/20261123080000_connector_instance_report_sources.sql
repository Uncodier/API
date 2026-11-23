BEGIN;
SET LOCAL lock_timeout = '5s';

-- Describe is advisory. Do not reserve a claim, lock a grant, create a default
-- revision or read business data just to describe a report. Evaluate the same
-- per-source policy as claim/store/open, including the independent grant epoch.
CREATE FUNCTION connector_result_private.describe_report_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c connector_result_private.direct_claims;
  entitlement uuid;
  sources jsonb := '{}'::jsonb;
  allowed text[];
  scope text;
  source text;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  -- a_apply already admitted this site's member and connector. Bind its exact
  -- epochs, and require the current trusted turn without invoking the write fence.
  IF current_setting('connector_scoped.status')::jsonb = jsonb_build_object(
    'connector_id',NEW.connector_id,'project_ref',NEW.project_ref,'connector_revision',NEW.connector_revision,
    'policy_revision',NEW.policy_revision,'direct_revision',NEW.direct_revision,'credential_revision',NEW.credential_revision)
    AND EXISTS (
      SELECT FROM connector_result_private.scoped_turn_heads h
      JOIN public.instance_logs l ON (l.id,l.site_id,l.instance_id)=(h.action_id,h.site_id,h.instance_id)
      JOIN connector_result_private.direct_ask_submissions s ON s.action_id=l.id AND s.member_authority
      WHERE (l.id,l.site_id,l.instance_id,l.agent_id,l.user_id)=(NEW.request_id,NEW.site_id,NEW.instance_id,NEW.agent_id,NEW.owner_id)
        AND l.log_type='user_action' AND l.trusted_user_action AND l.details->>'ask_request_sha256' COLLATE "C" ~ '^[a-f0-9]{64}$'
        AND l.details->>'status'='running' AND l.details @> '{"assistant_recovery":{"version":1,"respawnCount":0,"inFlight":true,"inFlightKind":"turn","execution":{"catalogUserSession":true,"callerSource":"interactive","executionMode":"direct"}}}'::jsonb
        AND NOT ((l.details->'assistant_recovery') ?| ARRAY['lease_token','conversationOnly'])
        AND NOT ((l.details #> '{assistant_recovery,execution}') ? 'instanceNodeId')
        AND coalesce(l.details #> '{assistant_recovery,execution,expectedResultsAmount}','1'::jsonb)='1'::jsonb
        AND coalesce(l.details #> '{assistant_recovery,execution,connectorIdHint}',to_jsonb(NEW.connector_id))=to_jsonb(NEW.connector_id)
    ) THEN
    c.site_id:=NEW.site_id; c.owner_id:=NEW.owner_id; c.instance_id:=NEW.instance_id; c.agent_id:=NEW.agent_id;
    c.request_id:=NEW.request_id; c.connector_id:=NEW.connector_id; c.project_ref:=NEW.project_ref;
    c.tool:='SUPABASE_RUN_READ_ONLY_QUERY'; c.connector_revision:=NEW.connector_revision; c.policy_revision:=NEW.policy_revision;
    c.direct_revision:=NEW.direct_revision; c.credential_revision:=NEW.credential_revision;
    SELECT g.id INTO entitlement FROM connector_result_private.analytics_grants g
      WHERE (g.site_id,g.user_id,g.connector_id,g.agent_id,g.project_ref)=(c.site_id,c.owner_id,c.connector_id,c.agent_id,c.project_ref)
        AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp();
    FOREACH scope IN ARRAY ARRAY['workspace','platform'] LOOP
      IF scope='platform' AND entitlement IS NULL THEN CONTINUE; END IF;
      c.data_scope:=scope; c.grant_id:=CASE WHEN scope='platform' THEN entitlement END;
      allowed:=ARRAY[]::text[];
      FOREACH source IN ARRAY ARRAY['paid_sales','tender_awards','approved_orders'] LOOP
        c.source_name:=source;
        IF connector_result_private.scoped_claim_admitted(c) THEN allowed:=array_append(allowed,source); END IF;
      END LOOP;
      IF cardinality(allowed)>0 THEN sources:=sources || jsonb_build_object(scope,allowed); END IF;
    END LOOP;
  END IF;
  PERFORM set_config('connector_scoped.status',sources::text,true);
  RETURN NEW; -- z_authorize must still acknowledge actual requester SELECT visibility under authenticated RLS.
END $$;
REVOKE ALL ON FUNCTION connector_result_private.describe_report_sources() FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE TRIGGER b_report_sources BEFORE INSERT ON connector_direct_rpc.write_gate FOR EACH ROW
  WHEN (NEW.scoped_status IS TRUE AND NEW.request_id IS NOT NULL) EXECUTE FUNCTION connector_result_private.describe_report_sources();

-- The existing status RPC never supplies a request_id. Its exact DTO, and the
-- existing final claim, store and owner-read RPCs, remain unchanged.
CREATE FUNCTION public.connector_instance_report_sources(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_request_id uuid,
  p_connector_revision integer,p_policy_revision integer,p_direct_revision integer,p_credential_revision text,p_project_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb; prev text:=current_setting('connector_scoped.status',true); ack text:=current_setting('connector_direct.result_id',true);
BEGIN
  IF current_user<>'service_role' OR current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  IF p_request_id IS NULL THEN RETURN NULL; END IF;
  BEGIN
    PERFORM set_config('connector_scoped.status','',true),set_config('connector_direct.result_id','',true);
    INSERT INTO connector_direct_rpc.write_gate(site_id,owner_id,instance_id,agent_id,connector_id,request_id,scoped_status,
      connector_revision,policy_revision,direct_revision,credential_revision,project_ref)
    VALUES (p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_request_id,true,
      p_connector_revision,p_policy_revision,p_direct_revision,p_credential_revision,p_project_ref);
    IF nullif(current_setting('connector_direct.result_id'),'')::uuid=p_connector_id THEN result:=current_setting('connector_scoped.status')::jsonb; END IF;
    PERFORM set_config('connector_scoped.status',coalesce(prev,''),true),set_config('connector_direct.result_id',coalesce(ack,''),true);
  EXCEPTION WHEN insufficient_privilege THEN RETURN NULL; END;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.connector_instance_report_sources(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_instance_report_sources(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text) TO service_role;
COMMIT;