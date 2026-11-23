BEGIN;
SET LOCAL lock_timeout = '5s';

-- A derived Ask answer is separate from an optional saved provider record. It
-- must never be readable as workspace history, a Realtime row, or a tool result.
CREATE TABLE connector_result_private.ask_answers (
  action_id uuid PRIMARY KEY REFERENCES public.instance_logs(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  instance_id uuid NOT NULL REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  claims uuid[] NOT NULL CHECK (cardinality(claims) BETWEEN 1 AND 100),
  answer text NOT NULL CHECK (octet_length(answer) BETWEEN 1 AND 65536)
);
ALTER TABLE connector_result_private.ask_answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.ask_answers FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT SELECT ON connector_result_private.ask_answers TO connector_result_reader;
CREATE POLICY read_own_ask_answer ON connector_result_private.ask_answers FOR SELECT TO connector_result_reader
  USING (owner_id=auth.uid());

CREATE FUNCTION public.store_connector_ask_answer(p_action_id uuid,p_claim_ids uuid[],p_answer text,p_runtime jsonb DEFAULT '{}'::jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '3s' AS $$
DECLARE c connector_result_private.direct_claims; first_claim connector_result_private.direct_claims; details jsonb;
  claim_id uuid; link text := 'This answer uses private connector data. [Open your answer](/robots/private-answer/' || p_action_id::text || ').';
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  IF p_action_id IS NULL OR p_answer IS NULL OR octet_length(p_answer) NOT BETWEEN 1 AND 65536 OR
     p_claim_ids IS NULL OR cardinality(p_claim_ids) NOT BETWEEN 1 AND 100 THEN RAISE invalid_parameter_value; END IF;
  FOREACH claim_id IN ARRAY p_claim_ids LOOP
    SELECT j.* INTO c FROM connector_result_private.direct_claims j WHERE j.id=claim_id AND j.request_id=p_action_id;
    IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
    PERFORM connector_result_private.lock_direct_write(c);
    PERFORM connector_result_private.check_dispatch_authority(c);
    IF c.claimed_at<=clock_timestamp()-interval '1 hour' THEN RAISE insufficient_privilege; END IF;
    IF first_claim.id IS NULL THEN first_claim:=c;
    ELSIF (first_claim.site_id,first_claim.instance_id,first_claim.owner_id) IS DISTINCT FROM
          (c.site_id,c.instance_id,c.owner_id) THEN RAISE insufficient_privilege;
    END IF;
  END LOOP;
  -- The worker verified the parent's actual RLS before inference; delivery
  -- rechecks all dispatch authority above and the browser rechecks parent RLS.
  INSERT INTO connector_result_private.ask_answers(action_id,site_id,instance_id,owner_id,claims,answer)
    VALUES(p_action_id,first_claim.site_id,first_claim.instance_id,first_claim.owner_id,p_claim_ids,p_answer)
    ON CONFLICT (action_id) DO NOTHING;
  IF FOUND THEN
    details:=jsonb_build_object('response_type','assistant_response','user_log_id',p_action_id,'total_tool_calls',0);
    IF p_runtime->>'runtime_commit_sha' COLLATE "C" ~ '^[a-fA-F0-9]{40}$' THEN
      details:=details || jsonb_build_object('runtime_commit_sha',p_runtime->>'runtime_commit_sha');
    END IF;
    IF p_runtime->>'runtime_deployment_id' COLLATE "C" ~ '^dpl_[a-zA-Z0-9]{1,100}$' THEN
      details:=details || jsonb_build_object('runtime_deployment_id',p_runtime->>'runtime_deployment_id');
    END IF;
    INSERT INTO public.instance_logs(log_type,level,message,site_id,instance_id,user_id,parent_log_id,details)
    VALUES('agent_action','info',link,first_claim.site_id,first_claim.instance_id,first_claim.owner_id,p_action_id,details);
  ELSIF NOT EXISTS (SELECT FROM connector_result_private.ask_answers a WHERE a.action_id=p_action_id
      AND (a.site_id,a.instance_id,a.owner_id,a.claims,a.answer)=(first_claim.site_id,first_claim.instance_id,first_claim.owner_id,p_claim_ids,p_answer)) THEN
    RAISE insufficient_privilege;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.store_connector_ask_answer(uuid,uuid[],text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.store_connector_ask_answer(uuid,uuid[],text,jsonb) TO service_role;

CREATE FUNCTION public.connector_ask_answer_ready() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT current_user='service_role' AND current_setting('role',true)='service_role';
$$;
REVOKE ALL ON FUNCTION public.connector_ask_answer_ready() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.connector_ask_answer_ready() TO service_role;

-- Receipt lookup only, not a downstream read or a grant. Check all accounts
-- used by the answer against their original revision and current member use.
CREATE FUNCTION connector_result_private.ask_answer_current(p_action_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT current_setting('role',true)='authenticated' AND auth.jwt()->'is_anonymous'='false'::jsonb AND EXISTS (
    SELECT FROM connector_result_private.ask_answers a WHERE a.action_id=p_action_id AND a.owner_id=auth.uid()
    AND NOT EXISTS (
      SELECT FROM unnest(a.claims) AS wanted(id) LEFT JOIN connector_result_private.direct_claims c
        ON (c.id,c.request_id,c.site_id,c.instance_id,c.owner_id)=(wanted.id,a.action_id,a.site_id,a.instance_id,a.owner_id)
      WHERE c.id IS NULL OR (CASE WHEN c.authorization_id IS NOT NULL THEN connector_result_private.account_claim_admitted(c)
        ELSE connector_result_private.direct_claim_admitted(c) END) IS NOT TRUE));
$$;
REVOKE ALL ON FUNCTION connector_result_private.ask_answer_current(uuid) FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION connector_result_private.ask_answer_current(uuid) TO connector_result_reader;

CREATE FUNCTION public.read_connector_ask_answer(p_action_id uuid) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.answer FROM connector_result_private.ask_answers a WHERE a.action_id=p_action_id AND a.owner_id=auth.uid()
    AND connector_result_private.ask_answer_current(a.action_id) AND EXISTS (
      SELECT FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id)=(a.instance_id,a.site_id,auth.uid()));
$$;
REVOKE ALL ON FUNCTION public.read_connector_ask_answer(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_connector_ask_answer(uuid) TO authenticated;
GRANT CREATE ON SCHEMA public TO connector_result_reader;
ALTER FUNCTION public.read_connector_ask_answer(uuid) OWNER TO connector_result_reader;
REVOKE CREATE ON SCHEMA public FROM connector_result_reader;

COMMIT;