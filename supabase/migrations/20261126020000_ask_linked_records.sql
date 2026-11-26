BEGIN;
SET LOCAL lock_timeout = '5s';

-- Require the canonical workspace screen-scope migration; no fallback to a
-- role inferred from service-visible membership. Resolve the prerequisite now.
DO $$ BEGIN PERFORM 'public.read_workspace_screen_scope(uuid)'::regprocedure; END $$;

-- No FK to records: deletion must invalidate the answer, not erase its obligation.
ALTER TABLE connector_result_private.ask_answers ADD COLUMN record_ids uuid[] NOT NULL DEFAULT '{}',
  DROP CONSTRAINT ask_answers_claims_check,
  ADD CHECK (cardinality(record_ids)<=8 AND array_position(record_ids,NULL) IS NULL
    AND cardinality(claims)<=100 AND cardinality(claims)+cardinality(record_ids)>0);
ALTER TABLE connector_direct_rpc.ask_turn_gate ADD COLUMN requested_ids uuid[], ADD COLUMN record_ids uuid[],
  ADD COLUMN record_rows jsonb;
GRANT INSERT(requested_ids) ON connector_direct_rpc.ask_turn_gate TO service_role;

-- A connector enrollment is not required. Record a monotonic, content-free
-- watermark for every trusted action; deleting a newer log cannot revive an older turn.
CREATE TABLE connector_result_private.record_turn_heads (
  instance_id uuid PRIMARY KEY REFERENCES public.remote_instances ON DELETE CASCADE,
  action_id uuid NOT NULL, created_at timestamptz NOT NULL
);
ALTER TABLE connector_result_private.record_turn_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.record_turn_heads FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE FUNCTION connector_result_private.advance_record_turn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT (current_setting('role') IN ('postgres','service_role','supabase_admin') OR
    (current_setting('role')='none' AND session_user=current_user)) THEN RETURN NULL; END IF;
  INSERT INTO connector_result_private.record_turn_heads AS h VALUES (NEW.instance_id,NEW.id,NEW.created_at)
    ON CONFLICT (instance_id) DO UPDATE SET action_id=EXCLUDED.action_id, created_at=EXCLUDED.created_at
    WHERE (h.created_at,h.action_id)<(EXCLUDED.created_at,EXCLUDED.action_id);
  RETURN NULL;
END $$;
CREATE TRIGGER ask_record_head AFTER INSERT ON public.instance_logs FOR EACH ROW
  WHEN (NEW.log_type='user_action' AND NEW.trusted_user_action) EXECUTE FUNCTION connector_result_private.advance_record_turn();

-- The ingress parses links once. An older server checkpoint replacing details
-- must not be able to silently remove this turn's obligation either.
CREATE FUNCTION connector_result_private.freeze_ask_record_links() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE insufficient_privilege; END $$;
REVOKE ALL ON FUNCTION connector_result_private.freeze_ask_record_links() FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
CREATE TRIGGER ask_freeze_record_links BEFORE UPDATE ON public.instance_logs FOR EACH ROW
  WHEN (OLD.details ? 'ask_request_sha256' AND
    (OLD.details->'ask_linked_record_ids') IS DISTINCT FROM (NEW.details->'ask_linked_record_ids'))
  EXECUTE FUNCTION connector_result_private.freeze_ask_record_links();

-- Same bounded history rule for every API generation. No callers can select
-- their own source, omit an inherited ID, or add arbitrary accessible rows.
CREATE FUNCTION connector_result_private.ask_prior(act public.instance_logs) RETURNS uuid
LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT a.action_id FROM (
    SELECT l.id,l.created_at FROM public.instance_logs l WHERE l.instance_id=act.instance_id AND l.log_type='user_action'
      AND l.trusted_user_action AND (l.created_at,l.id)<(act.created_at,act.id) ORDER BY l.created_at DESC,l.id DESC LIMIT 30
  ) h JOIN connector_result_private.ask_answers a ON a.action_id=h.id
    WHERE (a.site_id,a.owner_id,a.instance_id)=(act.site_id,act.user_id,act.instance_id)
    ORDER BY h.created_at DESC,h.id DESC LIMIT 1;
$$;
CREATE FUNCTION connector_result_private.ask_required_records(act public.instance_logs, prior uuid) RETURNS uuid[]
LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT ARRAY(SELECT id FROM (
    SELECT value::uuid AS id FROM jsonb_array_elements_text(act.details->'ask_linked_record_ids')
    UNION SELECT unnest(a.record_ids) FROM connector_result_private.ask_answers a WHERE a.action_id=prior
  ) ids ORDER BY id);
$$;

-- Guard old answer writers too (including direct service inserts through old
-- trigger gates). A legacy writer which cannot retain the obligations fails.
CREATE FUNCTION connector_result_private.guard_record_answer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE act public.instance_logs;
BEGIN
  SELECT * INTO STRICT act FROM public.instance_logs WHERE id=NEW.action_id;
  IF NEW.record_ids IS DISTINCT FROM connector_result_private.ask_required_records(act,connector_result_private.ask_prior(act))
    THEN RAISE insufficient_privilege; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ask_record_answer BEFORE INSERT ON connector_result_private.ask_answers FOR EACH ROW
  EXECUTE FUNCTION connector_result_private.guard_record_answer();
CREATE FUNCTION connector_result_private.guard_legacy_record_followup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS (SELECT FROM connector_result_private.ask_answers a WHERE a.action_id=NEW.source_id AND cardinality(a.record_ids)>0)
    OR EXISTS (SELECT FROM public.instance_logs l WHERE l.id=NEW.action_id AND
      cardinality(connector_result_private.ask_required_records(l,connector_result_private.ask_prior(l)))>0) THEN
    IF NEW.answer IS NOT NULL THEN RAISE insufficient_privilege; END IF;
    PERFORM set_config('connector_direct.followup','{"unavailable":true}',true);
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_legacy_records BEFORE INSERT ON connector_direct_rpc.ask_followup_gate FOR EACH ROW
  EXECUTE FUNCTION connector_result_private.guard_legacy_record_followup();

-- Actor-bound screen predicate shared by the worker's actual authenticated
-- SELECT and the browser's authenticated SELECT.
-- No content, user IDs as parameters, or privileged table access in this helper.
CREATE SCHEMA ask_record_auth;
REVOKE ALL ON SCHEMA ask_record_auth FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA ask_record_auth TO authenticated;
CREATE FUNCTION ask_record_auth.visible(p_site uuid,p_instance uuid,p_ids uuid[]) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' SET row_security=on AS $$
DECLARE scope jsonb;
BEGIN
  IF current_setting('role')<>'authenticated' OR auth.jwt()->'is_anonymous' IS DISTINCT FROM 'false'::jsonb
    OR NOT row_security_active('public.records') OR NOT row_security_active('public.remote_instances')
    OR NOT EXISTS (SELECT FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id)=(p_instance,p_site,auth.uid())
      AND i.is_archived IS FALSE) THEN RETURN false; END IF;
  scope:=public.read_workspace_screen_scope(p_site);
  RETURN (scope->>'actor_id'=auth.uid()::text AND scope->>'site_id'=p_site::text
    AND jsonb_typeof(scope->'blocked_screens')='array' AND (scope->>'role' IN ('owner','admin') OR
      (scope->>'role' IN ('collaborator','marketing') AND NOT (scope->'blocked_screens' ? 'records')))
    AND cardinality(p_ids) BETWEEN 1 AND 8 AND cardinality(p_ids)=(SELECT count(*) FROM public.records r
      WHERE r.site_id=p_site AND r.deleted_at IS NULL AND r.id=ANY(p_ids))) IS TRUE;
END $$;
REVOKE ALL ON FUNCTION ask_record_auth.visible(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ask_record_auth.visible(uuid,uuid,uuid[]) TO authenticated;

-- The browser enters as itself, not as the non-bypass answer table reader.
-- There is no client-selectable site/owner/provenance and no SELECT on the gate.
CREATE TABLE ask_record_auth.answer_gate (action_id uuid,site_id uuid,instance_id uuid,record_ids uuid[], CHECK(false));
ALTER TABLE ask_record_auth.answer_gate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ask_record_auth.answer_gate FROM PUBLIC,anon,authenticated,service_role;
GRANT INSERT(action_id) ON ask_record_auth.answer_gate TO authenticated;
CREATE FUNCTION connector_result_private.scope_record_answer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF current_setting('role')<>'authenticated' OR auth.jwt()->'is_anonymous' IS DISTINCT FROM 'false'::jsonb THEN RETURN NULL; END IF;
  SELECT a.site_id,a.instance_id,a.record_ids INTO NEW.site_id,NEW.instance_id,NEW.record_ids
    FROM connector_result_private.ask_answers a WHERE a.action_id=NEW.action_id AND a.owner_id=auth.uid()
    AND connector_result_private.ask_answer_current(a.action_id);
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION connector_result_private.authorize_record_answer() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET row_security=on AS $$
BEGIN
  IF current_user<>'authenticated' OR NOT row_security_active('public.remote_instances') OR NOT EXISTS (
    SELECT FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id)=(NEW.instance_id,NEW.site_id,auth.uid()))
    OR (cardinality(NEW.record_ids)>0 AND NOT ask_record_auth.visible(NEW.site_id,NEW.instance_id,NEW.record_ids))
    THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION connector_result_private.finish_record_answer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM set_config('connector_direct.browser_answer',a.answer,true) FROM connector_result_private.ask_answers a
    WHERE a.action_id=NEW.action_id AND a.owner_id=auth.uid() AND a.record_ids=NEW.record_ids;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.scope_record_answer(),connector_result_private.authorize_record_answer(),
  connector_result_private.finish_record_answer() FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
CREATE TRIGGER a_scope BEFORE INSERT ON ask_record_auth.answer_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.scope_record_answer();
CREATE TRIGGER b_authorize BEFORE INSERT ON ask_record_auth.answer_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.authorize_record_answer();
CREATE TRIGGER c_finish BEFORE INSERT ON ask_record_auth.answer_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.finish_record_answer();
CREATE OR REPLACE FUNCTION public.read_connector_ask_answer(p_action_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE previous text:=current_setting('connector_direct.browser_answer',true); result text;
BEGIN
  IF current_user<>'authenticated' OR current_setting('role')<>'authenticated' THEN RETURN NULL; END IF;
  PERFORM set_config('connector_direct.browser_answer','',true);
  INSERT INTO ask_record_auth.answer_gate(action_id) VALUES(p_action_id);
  result:=nullif(current_setting('connector_direct.browser_answer'),'');
  PERFORM set_config('connector_direct.browser_answer',coalesce(previous,''),true);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION connector_result_private.scope_ask_turn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE act public.instance_logs; prior uuid; required uuid[];
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  SELECT l.* INTO act FROM public.instance_logs l JOIN connector_result_private.direct_ask_submissions s ON s.action_id=l.id
    WHERE l.id=NEW.action_id AND l.log_type='user_action' AND l.trusted_user_action AND l.details->>'status'='running'
    AND l.details @> '{"assistant_recovery":{"version":1,"respawnCount":0,"inFlight":true,"inFlightKind":"turn","execution":{"catalogUserSession":true,"callerSource":"interactive","executionMode":"direct"}}}'::jsonb
    AND NOT ((l.details->'assistant_recovery') ?| ARRAY['lease_token','conversationOnly'])
    AND NOT ((l.details #> '{assistant_recovery,execution}') ? 'instanceNodeId')
    AND coalesce(l.details #> '{assistant_recovery,execution,expectedResultsAmount}','1'::jsonb)='1'::jsonb;
  IF NOT FOUND THEN
    IF NEW.answer IS NOT NULL OR NEW.requested_ids IS NOT NULL THEN RAISE insufficient_privilege; END IF;
    RETURN NULL;
  END IF;
  NEW.owner_id:=act.user_id; NEW.site_id:=act.site_id; NEW.instance_id:=act.instance_id;
  prior:=connector_result_private.ask_prior(act);
  required:=connector_result_private.ask_required_records(act,prior);
  IF cardinality(required)>8 OR array_position(required,NULL) IS NOT NULL THEN RAISE invalid_parameter_value; END IF;
  IF NEW.requested_ids IS NOT NULL THEN
    IF cardinality(required)=0 OR cardinality(NEW.requested_ids)<>cardinality(required) OR NOT (NEW.requested_ids @> required)
      THEN RAISE insufficient_privilege; END IF;
  ELSIF NEW.answer IS NOT NULL AND cardinality(required)>0 THEN RAISE insufficient_privilege;
  END IF;
  -- Serialize publication with the next submission, not only with changes to
  -- this action. A deleted newer action keeps the lockable head above.
  NEW.record_ids:=required;
  IF NEW.answer IS NOT NULL AND NEW.source_id IS DISTINCT FROM prior THEN RAISE insufficient_privilege; END IF;
  NEW.source_id:=prior;
  IF prior IS NULL AND NEW.answer IS NULL AND NEW.requested_ids IS NULL THEN RETURN NULL; END IF;
  -- Match lock_direct_write lock order for mixed inherited/fresh turns.
  PERFORM FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id)=(act.instance_id,act.site_id,act.user_id) FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  IF cardinality(required)>0 THEN
    IF act.details->>'prompt_source' IS DISTINCT FROM 'assistant_route' OR
      current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') OR
      (act.details->>'ask_request_sha256' COLLATE "C" ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE insufficient_privilege; END IF;
    PERFORM FROM connector_result_private.record_turn_heads h WHERE (h.instance_id,h.action_id)=(act.instance_id,act.id) FOR SHARE;
    IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
    -- Include pre-migration actions which have no native watermark.
    IF EXISTS (SELECT FROM public.instance_logs l WHERE l.instance_id=act.instance_id AND l.log_type='user_action'
      AND l.trusted_user_action AND (l.created_at,l.id)>(act.created_at,act.id)) THEN RAISE insufficient_privilege; END IF;
  END IF;
  IF cardinality(required)=0 OR EXISTS (SELECT FROM connector_result_private.ask_answers a WHERE a.action_id=prior AND cardinality(a.claims)>0)
    OR cardinality(NEW.claim_ids)>0 THEN
    PERFORM FROM connector_result_private.direct_turn_heads h WHERE (h.action_id,h.instance_id,h.site_id)=(act.id,act.instance_id,act.site_id) FOR SHARE;
    IF NOT FOUND THEN
      IF NEW.answer IS NOT NULL OR NEW.requested_ids IS NOT NULL THEN RAISE insufficient_privilege; END IF;
      PERFORM set_config('connector_direct.turn_context','{"unavailable":true}',true);
      RETURN NULL;
    END IF;
  END IF;
  PERFORM FROM public.instance_logs l WHERE l.id=act.id AND (l.details,l.site_id,l.user_id,l.instance_id,l.trusted_user_action,l.log_type,l.created_at)
    =(act.details,act.site_id,act.user_id,act.instance_id,true,'user_action',act.created_at) FOR UPDATE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION connector_result_private.authorize_ask_turn() RETURNS trigger
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
  IF cardinality(NEW.record_ids)>0 THEN
    IF NOT ask_record_auth.visible(NEW.site_id,NEW.instance_id,NEW.record_ids) THEN RAISE insufficient_privilege; END IF;
    IF NEW.requested_ids IS NOT NULL AND NEW.answer IS NULL THEN
      -- One bounded projection per requested ID. Refuse, never truncate, an oversized source.
      SELECT jsonb_agg(to_jsonb(projected) ORDER BY projected.id) INTO NEW.record_rows FROM (
        SELECT r.id,r.title,r.description,r.data,r.updated_at FROM public.records r WHERE r.site_id=NEW.site_id
          AND r.deleted_at IS NULL AND r.id=ANY(NEW.record_ids)
          AND coalesce(octet_length(r.data::text),0)+coalesce(octet_length(r.title),0)::bigint+coalesce(octet_length(r.description),0)<=131072
      ) projected;
      IF jsonb_array_length(NEW.record_rows) IS DISTINCT FROM cardinality(NEW.record_ids) OR octet_length(NEW.record_rows::text)>131072
        THEN RAISE invalid_parameter_value; END IF;
    END IF;
  END IF;
  FOR i IN 1..cardinality(names) LOOP PERFORM set_config(names[i],saved[i],true); END LOOP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION connector_result_private.finish_ask_turn() RETURNS trigger
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
  IF NEW.answer IS NULL AND NEW.requested_ids IS NOT NULL THEN
    PERFORM set_config('connector_direct.linked_record_rows',NEW.record_rows::text,true);
    RETURN NULL;
  END IF;
  IF NEW.answer IS NULL THEN
    SELECT array_agg(DISTINCT dc.connector_id ORDER BY dc.connector_id) INTO connectors FROM connector_result_private.direct_claims dc WHERE dc.id=ANY(claims);
    PERFORM set_config('connector_direct.turn_context',(jsonb_build_object('source_id',prior.action_id,'answer',prior.answer,
      'connector_ids',coalesce(connectors,'{}'),'tool_context',entries) || CASE WHEN cardinality(prior.record_ids)>0 THEN
      jsonb_build_object('record_ids',prior.record_ids) ELSE '{}'::jsonb END)::text,true);
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
  IF cardinality(claims)>100 OR cardinality(claims)+cardinality(NEW.record_ids)=0 THEN RAISE invalid_parameter_value; END IF;
  entries:=entries || NEW.entries;
  WHILE jsonb_array_length(entries)>8 OR octet_length(entries::text)>131072 LOOP entries:=entries - 0; END LOOP;
  INSERT INTO connector_result_private.ask_answers(action_id,site_id,owner_id,instance_id,claims,answer,record_ids)
    VALUES(NEW.action_id,NEW.site_id,NEW.owner_id,NEW.instance_id,claims,NEW.answer,NEW.record_ids) ON CONFLICT DO NOTHING;
  saved:=FOUND;
  IF saved THEN
    INSERT INTO connector_result_private.ask_turn_context VALUES(NEW.action_id,entries);
    details:=jsonb_build_object('response_type','assistant_response','user_log_id',NEW.action_id,'total_tool_calls',cardinality(NEW.claim_ids));
    IF NEW.runtime->>'runtime_commit_sha' COLLATE "C" ~ '^[a-fA-F0-9]{40}$' THEN details:=details || jsonb_build_object('runtime_commit_sha',NEW.runtime->>'runtime_commit_sha'); END IF;
    IF NEW.runtime->>'runtime_deployment_id' COLLATE "C" ~ '^dpl_[a-zA-Z0-9]{1,100}$' THEN details:=details || jsonb_build_object('runtime_deployment_id',NEW.runtime->>'runtime_deployment_id'); END IF;
    INSERT INTO public.instance_logs(log_type,level,message,site_id,instance_id,user_id,parent_log_id,details)
      VALUES('agent_action','info','This answer uses private ' || CASE WHEN cardinality(NEW.record_ids)>0 THEN 'workspace' ELSE 'connector' END || ' data. [Open your answer](/robots/private-answer/' || NEW.action_id || ').',
      NEW.site_id,NEW.instance_id,NEW.owner_id,NEW.action_id,details);
  ELSIF NOT EXISTS (SELECT FROM connector_result_private.ask_answers a JOIN connector_result_private.ask_turn_context x USING(action_id)
    WHERE a.action_id=NEW.action_id AND (a.site_id,a.owner_id,a.instance_id,a.claims,a.answer,x.entries,a.record_ids)=
      (NEW.site_id,NEW.owner_id,NEW.instance_id,turn.claims,NEW.answer,turn.entries,NEW.record_ids)) THEN RAISE insufficient_privilege;
  END IF;
  PERFORM set_config('connector_direct.turn_context','true',true);
  RETURN NULL;
END $$;
DROP TRIGGER b_authorize ON connector_direct_rpc.ask_turn_gate;
CREATE TRIGGER b_authorize BEFORE INSERT ON connector_direct_rpc.ask_turn_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.authorize_ask_turn();
REVOKE ALL ON FUNCTION connector_result_private.advance_record_turn(),connector_result_private.ask_prior(public.instance_logs),
  connector_result_private.ask_required_records(public.instance_logs,uuid),connector_result_private.guard_record_answer(),
  connector_result_private.guard_legacy_record_followup(),connector_result_private.authorize_ask_turn()
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

CREATE FUNCTION public.read_ask_linked_records(p_action_id uuid,p_record_ids uuid[])
RETURNS TABLE(id uuid,title text,description text,data jsonb,updated_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE rows jsonb; previous text:=current_setting('connector_direct.linked_record_rows',true);
  previous_context text:=current_setting('connector_direct.turn_context',true);
BEGIN
  IF current_user<>'service_role' OR current_setting('role')<>'service_role' THEN RAISE insufficient_privilege; END IF;
  IF (cardinality(p_record_ids) BETWEEN 1 AND 8) IS NOT TRUE OR array_ndims(p_record_ids)<>1 THEN RAISE invalid_parameter_value; END IF;
  PERFORM set_config('connector_direct.linked_record_rows','',true);
  INSERT INTO connector_direct_rpc.ask_turn_gate(action_id,requested_ids) VALUES(p_action_id,p_record_ids);
  rows:=nullif(current_setting('connector_direct.linked_record_rows'),'')::jsonb;
  PERFORM set_config('connector_direct.linked_record_rows',coalesce(previous,''),true);
  PERFORM set_config('connector_direct.turn_context',coalesce(previous_context,''),true);
  IF jsonb_array_length(rows) IS DISTINCT FROM cardinality(p_record_ids) THEN RAISE insufficient_privilege; END IF;
  RETURN QUERY SELECT * FROM jsonb_to_recordset(rows) r(id uuid,title text,description text,data jsonb,updated_at timestamptz);
END $$;
CREATE FUNCTION public.store_linked_record_ask_turn(p_action_id uuid,p_claim_ids uuid[],p_answer text,p_tool_context jsonb,
  p_source_id uuid,p_runtime jsonb,p_record_ids uuid[]) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE previous text:=current_setting('connector_direct.turn_context',true); confirmed boolean;
BEGIN
  IF current_user<>'service_role' OR current_setting('role')<>'service_role' THEN RAISE insufficient_privilege; END IF;
  IF p_answer IS NULL OR (cardinality(p_record_ids) BETWEEN 1 AND 8) IS NOT TRUE OR array_ndims(p_record_ids)<>1 THEN RAISE invalid_parameter_value; END IF;
  PERFORM set_config('connector_direct.turn_context','',true);
  INSERT INTO connector_direct_rpc.ask_turn_gate(action_id,source_id,claim_ids,answer,entries,runtime,requested_ids)
    VALUES(p_action_id,p_source_id,p_claim_ids,p_answer,p_tool_context,p_runtime,p_record_ids);
  confirmed:=current_setting('connector_direct.turn_context')='true';
  PERFORM set_config('connector_direct.turn_context',coalesce(previous,''),true);
  RETURN confirmed;
END $$;
REVOKE ALL ON FUNCTION public.read_ask_linked_records(uuid,uuid[]),public.store_linked_record_ask_turn(uuid,uuid[],text,jsonb,uuid,jsonb,uuid[])
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.read_ask_linked_records(uuid,uuid[]),public.store_linked_record_ask_turn(uuid,uuid[],text,jsonb,uuid,jsonb,uuid[])
  TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
