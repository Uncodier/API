BEGIN;
SET LOCAL lock_timeout = '5s';

-- Store bounded, already projected tool values separately from both the browser
-- answer and the optional provider record. Legacy answers start without rows.
CREATE TABLE connector_result_private.ask_turn_context (
  action_id uuid PRIMARY KEY REFERENCES connector_result_private.ask_answers ON DELETE CASCADE,
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries)='array' AND jsonb_array_length(entries)<=8
    AND octet_length(entries::text)<=131072)
);
ALTER TABLE connector_result_private.ask_turn_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.ask_turn_context FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

CREATE TABLE connector_direct_rpc.ask_turn_gate (
  action_id uuid, source_id uuid, answer text, claim_ids uuid[], entries jsonb, runtime jsonb,
  owner_id uuid, site_id uuid, instance_id uuid, CHECK (false)
);
ALTER TABLE connector_direct_rpc.ask_turn_gate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_direct_rpc.ask_turn_gate FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT INSERT(action_id,source_id,answer,claim_ids,entries,runtime) ON connector_direct_rpc.ask_turn_gate TO service_role;

CREATE FUNCTION connector_result_private.scope_ask_turn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE act public.instance_logs; prior uuid;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  SELECT l.* INTO act FROM public.instance_logs l JOIN connector_result_private.direct_ask_submissions s ON s.action_id=l.id
    WHERE l.id=NEW.action_id AND l.log_type='user_action' AND l.trusted_user_action AND l.details->>'status'='running'
    AND l.details @> '{"assistant_recovery":{"version":1,"respawnCount":0,"inFlight":true,"inFlightKind":"turn","execution":{"catalogUserSession":true,"callerSource":"interactive","executionMode":"direct"}}}'::jsonb
    AND NOT ((l.details->'assistant_recovery') ?| ARRAY['lease_token','conversationOnly'])
    AND NOT ((l.details #> '{assistant_recovery,execution}') ? 'instanceNodeId')
    AND coalesce(l.details #> '{assistant_recovery,execution,expectedResultsAmount}','1'::jsonb)='1'::jsonb;
  IF NOT FOUND THEN
    IF NEW.answer IS NOT NULL THEN RAISE insufficient_privilege; END IF;
    RETURN NULL;
  END IF;
  NEW.owner_id:=act.user_id; NEW.site_id:=act.site_id; NEW.instance_id:=act.instance_id;
  SELECT a.action_id INTO prior FROM (
    SELECT l.id,l.created_at FROM public.instance_logs l WHERE l.instance_id=act.instance_id AND l.log_type='user_action'
      AND l.trusted_user_action AND (l.created_at,l.id)<(act.created_at,act.id) ORDER BY l.created_at DESC,l.id DESC LIMIT 30
  ) history JOIN connector_result_private.ask_answers a ON a.action_id=history.id
    WHERE (a.site_id,a.owner_id,a.instance_id)=(act.site_id,act.user_id,act.instance_id)
    ORDER BY history.created_at DESC,history.id DESC LIMIT 1;
  IF NEW.answer IS NOT NULL AND NEW.source_id IS DISTINCT FROM prior THEN RAISE insufficient_privilege; END IF;
  NEW.source_id:=prior;
  IF prior IS NULL AND NEW.answer IS NULL THEN RETURN NULL; END IF;
  -- Match lock_direct_write lock order for mixed inherited/fresh turns.
  PERFORM FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id)=(act.instance_id,act.site_id,act.user_id) FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM connector_result_private.direct_turn_heads h WHERE (h.action_id,h.instance_id,h.site_id)=(act.id,act.instance_id,act.site_id) FOR SHARE;
  IF NOT FOUND THEN
    IF NEW.answer IS NOT NULL THEN RAISE insufficient_privilege; END IF;
    PERFORM set_config('connector_direct.turn_context','{"unavailable":true}',true);
    RETURN NULL;
  END IF;
  PERFORM FROM public.instance_logs l WHERE l.id=act.id AND l.details=act.details FOR UPDATE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION connector_result_private.finish_ask_turn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
<<turn>>
DECLARE prior connector_result_private.ask_answers; claims uuid[]:='{}'; entries jsonb:='[]'; c connector_result_private.direct_claims;
  connectors uuid[]; claim uuid; item jsonb; details jsonb; saved boolean;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  IF NEW.source_id IS NOT NULL THEN
    SELECT * INTO STRICT prior FROM connector_result_private.ask_answers a WHERE
      (a.action_id,a.site_id,a.owner_id,a.instance_id)=(NEW.source_id,NEW.site_id,NEW.owner_id,NEW.instance_id) FOR SHARE;
    IF EXISTS (SELECT FROM unnest(prior.claims) wanted(id) LEFT JOIN connector_result_private.direct_claims dc
      ON (dc.id,dc.site_id,dc.owner_id,dc.instance_id)=(wanted.id,prior.site_id,prior.owner_id,prior.instance_id)
      WHERE dc.id IS NULL OR (CASE WHEN dc.authorization_id IS NULL THEN connector_result_private.direct_claim_admitted(dc)
        ELSE connector_result_private.account_claim_admitted(dc) END) IS NOT TRUE) THEN
      IF NEW.answer IS NOT NULL THEN RAISE insufficient_privilege; END IF;
      PERFORM set_config('connector_direct.turn_context','{"unavailable":true}',true);
      RETURN NULL;
    END IF;
    claims:=prior.claims;
    SELECT coalesce((SELECT x.entries FROM connector_result_private.ask_turn_context x WHERE x.action_id=prior.action_id),'[]'::jsonb) INTO entries;
  END IF;
  IF NEW.answer IS NULL THEN
    SELECT array_agg(DISTINCT dc.connector_id ORDER BY dc.connector_id) INTO connectors FROM connector_result_private.direct_claims dc WHERE dc.id=ANY(claims);
    PERFORM set_config('connector_direct.turn_context',jsonb_build_object('source_id',prior.action_id,'answer',prior.answer,
      'connector_ids',connectors,'tool_context',entries)::text,true);
    RETURN NULL;
  END IF;
  IF octet_length(NEW.answer) NOT BETWEEN 1 AND 65536 OR NEW.claim_ids IS NULL OR cardinality(NEW.claim_ids)>100
    OR NEW.entries IS NULL OR jsonb_typeof(NEW.entries)<>'array' OR jsonb_array_length(NEW.entries)>8 OR octet_length(NEW.entries::text)>131072
    THEN RAISE invalid_parameter_value; END IF;
  FOREACH claim IN ARRAY NEW.claim_ids LOOP
    SELECT * INTO c FROM connector_result_private.direct_claims dc WHERE
      (dc.id,dc.request_id,dc.site_id,dc.owner_id,dc.instance_id)=(claim,NEW.action_id,NEW.site_id,NEW.owner_id,NEW.instance_id);
    IF NOT FOUND OR c.claimed_at<=clock_timestamp()-interval '1 hour' THEN RAISE insufficient_privilege; END IF;
    PERFORM connector_result_private.lock_direct_write(c);
    PERFORM connector_result_private.check_dispatch_authority(c);
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.entries) LOOP
    IF jsonb_typeof(item)<>'object' OR NOT (item ?& ARRAY['claim_id','result']) OR item - ARRAY['claim_id','result'] <> '{}'::jsonb
      OR ((item->>'claim_id')::uuid = ANY(NEW.claim_ids)) IS NOT TRUE THEN RAISE invalid_parameter_value; END IF;
  END LOOP;
  SELECT ARRAY(SELECT DISTINCT id FROM unnest(claims || NEW.claim_ids) u(id) ORDER BY id) INTO claims;
  IF cardinality(claims) NOT BETWEEN 1 AND 100 THEN RAISE invalid_parameter_value; END IF;
  entries:=entries || NEW.entries;
  WHILE jsonb_array_length(entries)>8 OR octet_length(entries::text)>131072 LOOP entries:=entries - 0; END LOOP;
  INSERT INTO connector_result_private.ask_answers(action_id,site_id,owner_id,instance_id,claims,answer)
    VALUES(NEW.action_id,NEW.site_id,NEW.owner_id,NEW.instance_id,claims,NEW.answer) ON CONFLICT DO NOTHING;
  saved:=FOUND;
  IF saved THEN
    INSERT INTO connector_result_private.ask_turn_context VALUES(NEW.action_id,entries);
    details:=jsonb_build_object('response_type','assistant_response','user_log_id',NEW.action_id,'total_tool_calls',cardinality(NEW.claim_ids));
    IF NEW.runtime->>'runtime_commit_sha' COLLATE "C" ~ '^[a-fA-F0-9]{40}$' THEN details:=details || jsonb_build_object('runtime_commit_sha',NEW.runtime->>'runtime_commit_sha'); END IF;
    IF NEW.runtime->>'runtime_deployment_id' COLLATE "C" ~ '^dpl_[a-zA-Z0-9]{1,100}$' THEN details:=details || jsonb_build_object('runtime_deployment_id',NEW.runtime->>'runtime_deployment_id'); END IF;
    INSERT INTO public.instance_logs(log_type,level,message,site_id,instance_id,user_id,parent_log_id,details)
      VALUES('agent_action','info','This answer uses private connector data. [Open your answer](/robots/private-answer/' || NEW.action_id || ').',
      NEW.site_id,NEW.instance_id,NEW.owner_id,NEW.action_id,details);
  ELSIF NOT EXISTS (SELECT FROM connector_result_private.ask_answers a JOIN connector_result_private.ask_turn_context x USING(action_id)
    WHERE a.action_id=NEW.action_id AND (a.site_id,a.owner_id,a.instance_id,a.claims,a.answer,x.entries)=
      (NEW.site_id,NEW.owner_id,NEW.instance_id,turn.claims,NEW.answer,turn.entries)) THEN RAISE insufficient_privilege;
  END IF;
  PERFORM set_config('connector_direct.turn_context','true',true);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.scope_ask_turn(),connector_result_private.finish_ask_turn() FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE TRIGGER a_scope BEFORE INSERT ON connector_direct_rpc.ask_turn_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.scope_ask_turn();
CREATE TRIGGER b_authorize BEFORE INSERT ON connector_direct_rpc.ask_turn_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.authorize_ask_followup();
CREATE TRIGGER c_finish BEFORE INSERT ON connector_direct_rpc.ask_turn_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.finish_ask_turn();

CREATE FUNCTION public.connector_ask_context(p_action_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE previous text:=current_setting('connector_direct.turn_context',true); result jsonb;
BEGIN
  IF current_user<>'service_role' OR current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  PERFORM set_config('connector_direct.turn_context','',true);
  INSERT INTO connector_direct_rpc.ask_turn_gate(action_id) VALUES(p_action_id);
  result:=nullif(current_setting('connector_direct.turn_context',true),'')::jsonb;
  PERFORM set_config('connector_direct.turn_context',coalesce(previous,''),true);
  RETURN result;
END $$;
CREATE FUNCTION public.store_connector_ask_turn(p_action_id uuid,p_claim_ids uuid[],p_answer text,p_tool_context jsonb,
  p_source_id uuid DEFAULT NULL,p_runtime jsonb DEFAULT '{}') RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE previous text:=current_setting('connector_direct.turn_context',true); confirmed boolean;
BEGIN
  IF current_user<>'service_role' OR current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  IF p_answer IS NULL THEN RAISE invalid_parameter_value; END IF;
  PERFORM set_config('connector_direct.turn_context','',true);
  INSERT INTO connector_direct_rpc.ask_turn_gate(action_id,source_id,claim_ids,answer,entries,runtime)
    VALUES(p_action_id,p_source_id,p_claim_ids,p_answer,p_tool_context,p_runtime);
  confirmed:=current_setting('connector_direct.turn_context',true)='true';
  PERFORM set_config('connector_direct.turn_context',coalesce(previous,''),true);
  RETURN confirmed;
END $$;
REVOKE ALL ON FUNCTION public.connector_ask_context(uuid),public.store_connector_ask_turn(uuid,uuid[],text,jsonb,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_ask_context(uuid),public.store_connector_ask_turn(uuid,uuid[],text,jsonb,uuid,jsonb) TO service_role;
COMMIT;
