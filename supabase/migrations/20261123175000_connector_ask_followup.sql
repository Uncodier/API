BEGIN;
SET LOCAL lock_timeout = '5s';

-- An inherited answer has no new provider dispatch. Its authority is still
-- the exact set of original claims, and never the existence of a chat link.
CREATE OR REPLACE FUNCTION connector_result_private.ask_answer_current(p_action_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT current_setting('role',true)='authenticated' AND auth.jwt()->'is_anonymous'='false'::jsonb AND EXISTS (
    SELECT FROM connector_result_private.ask_answers a WHERE a.action_id=p_action_id AND a.owner_id=auth.uid()
    AND NOT EXISTS (
      SELECT FROM unnest(a.claims) AS wanted(id) LEFT JOIN connector_result_private.direct_claims c
        ON (c.id,c.site_id,c.instance_id,c.owner_id)=(wanted.id,a.site_id,a.instance_id,a.owner_id)
      WHERE c.id IS NULL OR (CASE WHEN c.authorization_id IS NOT NULL THEN connector_result_private.account_claim_admitted(c)
        ELSE connector_result_private.direct_claim_admitted(c) END) IS NOT TRUE));
$$;

CREATE TABLE connector_direct_rpc.ask_followup_gate (
  action_id uuid, source_id uuid, answer text, owner_id uuid, site_id uuid, instance_id uuid, CHECK (false)
);
ALTER TABLE connector_direct_rpc.ask_followup_gate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_direct_rpc.ask_followup_gate FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT INSERT (action_id, source_id, answer) ON connector_direct_rpc.ask_followup_gate TO service_role;

CREATE FUNCTION connector_result_private.scope_ask_followup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE current_action public.instance_logs;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  SELECT l.* INTO current_action FROM public.instance_logs l
    JOIN connector_result_private.direct_ask_submissions s ON s.action_id=l.id
    WHERE l.id=NEW.action_id AND l.log_type='user_action' AND l.trusted_user_action
      AND l.details->>'status'='running' AND l.details @> '{"assistant_recovery":{"version":1,"respawnCount":0,"inFlight":true,"inFlightKind":"turn","execution":{"catalogUserSession":true,"callerSource":"interactive","executionMode":"direct"}}}'::jsonb
      AND NOT ((l.details->'assistant_recovery') ?| ARRAY['lease_token','conversationOnly'])
      AND NOT ((l.details #> '{assistant_recovery,execution}') ? 'instanceNodeId')
      AND coalesce(l.details #> '{assistant_recovery,execution,expectedResultsAmount}','1'::jsonb)='1'::jsonb;
  IF NOT FOUND THEN RETURN NULL; END IF;
  NEW.owner_id:=current_action.user_id; NEW.site_id:=current_action.site_id; NEW.instance_id:=current_action.instance_id;
  IF NEW.source_id IS NULL THEN
    -- Scan a bounded conversation window, never another instance or a raw tool result.
    SELECT a.action_id INTO NEW.source_id FROM (
      SELECT l.id, l.created_at FROM public.instance_logs l
        WHERE l.instance_id=NEW.instance_id AND l.log_type='user_action' AND l.trusted_user_action
          AND (l.created_at,l.id)<(current_action.created_at,current_action.id)
        ORDER BY l.created_at DESC,l.id DESC LIMIT 30
    ) prior JOIN connector_result_private.ask_answers a ON a.action_id=prior.id
      WHERE (a.owner_id,a.site_id,a.instance_id)=(NEW.owner_id,NEW.site_id,NEW.instance_id)
      ORDER BY prior.created_at DESC,prior.id DESC LIMIT 1;
  ELSIF NOT EXISTS (SELECT FROM public.instance_logs l WHERE l.id=NEW.source_id
      AND (l.created_at,l.id)<(current_action.created_at,current_action.id)) THEN
    RAISE insufficient_privilege;
  END IF;
  IF NEW.source_id IS NULL THEN RETURN NULL; END IF;
  -- Lock head before the active action, in the same order as dispatch.
  PERFORM FROM connector_result_private.direct_turn_heads h
    WHERE (h.action_id,h.instance_id,h.site_id)=(NEW.action_id,NEW.instance_id,NEW.site_id) FOR SHARE;
  IF NOT FOUND THEN
    IF NEW.answer IS NOT NULL THEN RAISE insufficient_privilege; END IF;
    PERFORM set_config('connector_direct.followup', '{"unavailable":true}', true);
    RETURN NULL;
  END IF;
  PERFORM FROM public.instance_logs l WHERE l.id=current_action.id AND l.details=current_action.details FOR UPDATE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  RETURN NEW;
END $$;

-- Match the existing connector RLS gate: no bearer token enters workflow state.
CREATE FUNCTION connector_result_private.authorize_ask_followup() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET role = authenticated SET row_security = on AS $$
DECLARE claims text:=jsonb_build_object('sub',NEW.owner_id,'role','authenticated','is_anonymous',false)::text;
  names text[]:=ARRAY['request.jwt.claims','request.jwt.claim','request.jwt.claim.sub','request.jwt.claim.role','request.headers','request.cookies'];
  replacements text[]:=ARRAY[claims,claims,NEW.owner_id::text,'authenticated','{}','{}']; saved text[]:=ARRAY[]::text[]; i integer;
BEGIN
  FOR i IN 1..cardinality(names) LOOP
    saved:=array_append(saved,coalesce(current_setting(names[i],true),''));
    PERFORM set_config(names[i],replacements[i],true);
  END LOOP;
  IF current_user<>'authenticated' OR current_setting('role')<>'authenticated' OR NOT row_security_active('public.remote_instances')
    OR auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS DISTINCT FROM NEW.owner_id OR auth.jwt()::jsonb IS DISTINCT FROM claims::jsonb
    OR NOT EXISTS (SELECT FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id)=(NEW.instance_id,NEW.site_id,auth.uid())) THEN
    RAISE insufficient_privilege;
  END IF;
  FOR i IN 1..cardinality(names) LOOP PERFORM set_config(names[i],saved[i],true); END LOOP;
  RETURN NEW;
END $$;

CREATE FUNCTION connector_result_private.finish_ask_followup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a connector_result_private.ask_answers;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO a FROM connector_result_private.ask_answers
    WHERE (action_id,site_id,instance_id,owner_id)=(NEW.source_id,NEW.site_id,NEW.instance_id,NEW.owner_id) FOR SHARE;
  IF NOT FOUND OR EXISTS (
    SELECT FROM unnest(a.claims) AS wanted(id) LEFT JOIN connector_result_private.direct_claims c
      ON (c.id,c.site_id,c.instance_id,c.owner_id)=(wanted.id,a.site_id,a.instance_id,a.owner_id)
    WHERE c.id IS NULL OR (CASE WHEN c.authorization_id IS NOT NULL THEN connector_result_private.account_claim_admitted(c)
      ELSE connector_result_private.direct_claim_admitted(c) END) IS NOT TRUE) THEN
    IF NEW.answer IS NOT NULL THEN RAISE insufficient_privilege; END IF;
    PERFORM set_config('connector_direct.followup', '{"unavailable":true}', true);
    RETURN NULL;
  END IF;
  IF NEW.answer IS NULL THEN
    PERFORM set_config('connector_direct.followup',jsonb_build_object('source_id',a.action_id,'answer',a.answer)::text,true);
  ELSE
    INSERT INTO connector_result_private.ask_answers(action_id,site_id,instance_id,owner_id,claims,answer)
      VALUES(NEW.action_id,a.site_id,a.instance_id,a.owner_id,a.claims,NEW.answer) ON CONFLICT (action_id) DO NOTHING;
    IF FOUND THEN
      INSERT INTO public.instance_logs(log_type,level,message,site_id,instance_id,user_id,parent_log_id,details)
        VALUES('agent_action','info','This answer uses private connector data. [Open your answer](/robots/private-answer/' || NEW.action_id || ').',
          a.site_id,a.instance_id,a.owner_id,NEW.action_id,
          jsonb_build_object('response_type','assistant_response','user_log_id',NEW.action_id,'total_tool_calls',0));
    ELSIF NOT EXISTS (SELECT FROM connector_result_private.ask_answers existing WHERE existing.action_id=NEW.action_id
        AND (existing.site_id,existing.instance_id,existing.owner_id,existing.claims,existing.answer)=(a.site_id,a.instance_id,a.owner_id,a.claims,NEW.answer)) THEN
      RAISE insufficient_privilege;
    END IF;
    PERFORM set_config('connector_direct.followup','true',true);
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION connector_result_private.scope_ask_followup(), connector_result_private.authorize_ask_followup(),
  connector_result_private.finish_ask_followup() FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE TRIGGER a_scope BEFORE INSERT ON connector_direct_rpc.ask_followup_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.scope_ask_followup();
CREATE TRIGGER b_authorize BEFORE INSERT ON connector_direct_rpc.ask_followup_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.authorize_ask_followup();
CREATE TRIGGER c_finish BEFORE INSERT ON connector_direct_rpc.ask_followup_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.finish_ask_followup();

CREATE FUNCTION public.connector_ask_followup(p_action_id uuid,p_source_id uuid DEFAULT NULL,p_answer text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '3s' AS $$
DECLARE result text; previous text:=current_setting('connector_direct.followup',true);
BEGIN
  IF current_user<>'service_role' OR current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  IF p_action_id IS NULL OR (p_source_id IS NULL)<>(p_answer IS NULL) OR octet_length(p_answer) NOT BETWEEN 1 AND 65536 THEN
    RAISE invalid_parameter_value;
  END IF;
  PERFORM set_config('connector_direct.followup','',true);
  INSERT INTO connector_direct_rpc.ask_followup_gate(action_id,source_id,answer) VALUES(p_action_id,p_source_id,p_answer);
  result:=nullif(current_setting('connector_direct.followup',true),'');
  PERFORM set_config('connector_direct.followup',coalesce(previous,''),true);
  RETURN result::jsonb;
END $$;
REVOKE ALL ON FUNCTION public.connector_ask_followup(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_ask_followup(uuid,uuid,text) TO service_role;

COMMIT;