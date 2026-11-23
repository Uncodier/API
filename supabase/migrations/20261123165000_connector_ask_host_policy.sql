BEGIN;
SET LOCAL lock_timeout = '5s';

-- Preserve existing opt-outs during cutover; never turn on a previously blocked account.
LOCK TABLE public.connectors, public.connector_policies, connector_result_private.direct_revisions,
  connector_result_private.direct_policy_events IN SHARE ROW EXCLUSIVE MODE;
WITH latest AS (
  SELECT DISTINCT ON (connector_id) connector_id, enabled
    FROM connector_result_private.direct_policy_events ORDER BY connector_id, direct_revision DESC
), moved AS (
  UPDATE public.connector_policies p
     SET allowed_hosts=array_remove(p.allowed_hosts,'assistant'), revision=p.revision+1, updated_at=now()
    FROM latest e WHERE e.connector_id=p.connector_id AND NOT e.enabled AND 'assistant'=ANY(p.allowed_hosts)
  RETURNING p.connector_id,p.site_id
)
UPDATE public.connectors c SET revision=c.revision+1, updated_at=now()
  FROM moved m WHERE (c.id,c.site_id)=(m.connector_id,m.site_id);

-- Existing admission/receipt callers now read the host policy, not the old audit journal.
CREATE OR REPLACE FUNCTION connector_result_private.direct_disabled(p_connector_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT NOT EXISTS (SELECT FROM public.connector_policies p
    WHERE p.connector_id=p_connector_id AND 'assistant'=ANY(p.allowed_hosts));
$$;

CREATE OR REPLACE FUNCTION public.connector_instance_policy_status(p_site_id uuid,p_actor_id uuid,p_connector_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r jsonb; assistant_allowed boolean;
BEGIN
  r := public.connector_ask_policy_status(p_site_id,p_actor_id,p_connector_id);
  assistant_allowed := NOT connector_result_private.direct_disabled(p_connector_id);
  IF connector_result_private.ordinary_authorization(p_site_id,p_connector_id) IS NOT NULL THEN
    r := r || jsonb_build_object('authority_kind','connected_account','enabled',assistant_allowed,'setup_pending',false);
  END IF;
  RETURN r || jsonb_build_object('authorization_mode','host_policy','assistant_allowed',assistant_allowed);
END $$;

-- Keep the offline stop path. It changes the same host setting without touching tools,
-- the account, or catalogue flags. Only the normal policy editor may turn it on.
CREATE OR REPLACE FUNCTION public.connector_set_ask_policy(p_site_id uuid,p_actor_id uuid,p_connector_id uuid,
  p_expected_revision integer,p_expected_direct_revision integer,p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_revision integer;
BEGIN
  v_revision := public.connector_lock_for_manager(p_site_id,p_connector_id,p_actor_id,p_expected_revision);
  IF p_enabled IS DISTINCT FROM false THEN RAISE invalid_parameter_value; END IF;
  INSERT INTO connector_result_private.direct_revisions(connector_id,direct_revision) VALUES (p_connector_id,1) ON CONFLICT DO NOTHING;
  UPDATE connector_result_private.direct_revisions SET direct_revision=direct_revision+1
    WHERE connector_id=p_connector_id AND direct_revision=p_expected_direct_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Direct revision conflict' USING ERRCODE='40001'; END IF;
  UPDATE public.connector_policies SET allowed_hosts=array_remove(allowed_hosts,'assistant'), revision=revision+1, updated_at=now()
    WHERE (connector_id,site_id)=(p_connector_id,p_site_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Connector policy unavailable' USING ERRCODE='22023'; END IF;
  UPDATE public.connectors SET revision=v_revision+1, updated_at=now() WHERE (id,site_id)=(p_connector_id,p_site_id);
  INSERT INTO public.connector_audit_events(site_id,connector_id,actor_id,event_type,revision)
    VALUES (p_site_id,p_connector_id,p_actor_id,'policy_updated',v_revision+1);
  RETURN public.connector_instance_policy_status(p_site_id,p_actor_id,p_connector_id);
END $$;

REVOKE EXECUTE ON FUNCTION public.connector_set_direct_policy(uuid,uuid,uuid,integer,integer,boolean),
  public.connector_save_policy_with_ask(uuid,uuid,uuid,integer,text[],text[],boolean,boolean,text,jsonb,boolean,boolean,integer)
  FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;

COMMIT;