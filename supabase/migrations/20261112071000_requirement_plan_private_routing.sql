BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Requires the shared database's 20261112022000 plan-routing migration first.
-- Preserve all existing requirement generation/lease/backlog checks verbatim.
ALTER FUNCTION public.patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint)
  RENAME TO patch_agent_requirement_plan_unrouted;
REVOKE ALL ON FUNCTION public.patch_agent_requirement_plan_unrouted(uuid,text,integer,uuid,uuid,text,jsonb,bigint)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.patch_agent_requirement_plan(
  p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid,
  p_plan_id uuid,p_title text,p_steps jsonb,p_expected_backlog_revision bigint,p_routing jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; plan_site uuid; stored jsonb;
BEGIN
  result:=public.patch_agent_requirement_plan_unrouted(p_requirement_id,p_run_id,p_generation,p_session_id,
    p_plan_id,p_title,p_steps,p_expected_backlog_revision);
  IF result->>'state' IN ('created','updated') THEN
    SELECT site_id INTO plan_site FROM public.instance_plans WHERE id=(result->>'plan_id')::uuid;
    IF result->>'state'='created' THEN
      -- Same transaction: a runnable plan is never visible without its private pin.
      PERFORM public.openrouter_plan_routing_pin((result->>'plan_id')::uuid,plan_site,p_routing);
    ELSE
      SELECT routing INTO stored FROM public.openrouter_plan_routing
        WHERE plan_id=(result->>'plan_id')::uuid AND site_id=plan_site;
      IF stored IS NULL THEN RAISE EXCEPTION 'Plan routing unavailable' USING ERRCODE='42501'; END IF;
      -- Updating an existing plan cannot change its immutable funding identity.
    END IF;
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint,jsonb)
  TO service_role;

-- Old binaries have only platform execution, never a customer selection. Preserve
-- that explicit legacy admission while making their new rows resumable after rollout.
CREATE FUNCTION public.patch_agent_requirement_plan(
  p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid,
  p_plan_id uuid,p_title text,p_steps jsonb,p_expected_backlog_revision bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE authorized_site uuid;
BEGIN
  SELECT site_id INTO authorized_site FROM public.requirements WHERE id=p_requirement_id;
  RETURN public.patch_agent_requirement_plan(p_requirement_id,p_run_id,p_generation,p_session_id,
    p_plan_id,p_title,p_steps,p_expected_backlog_revision,
    jsonb_build_object('payer','platform','siteId',authorized_site::text));
END;
$$;
REVOKE ALL ON FUNCTION public.patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint)
  TO service_role;
COMMIT;