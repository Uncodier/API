BEGIN;

-- Classification is not authorization: it deliberately does not look up the
-- remote_instances row, which is not visible during INSERT RETURNING checks.
-- Keep the existence-checking read RPC separate and fail closed for unknown IDs.
CREATE FUNCTION public.procurement_workflow_instance_is_private(p_instance uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_instance IS NULL
    OR EXISTS (SELECT 1 FROM public.procurement_workflow_private_instances WHERE instance_id=p_instance)
    OR EXISTS (SELECT 1 FROM public.workflow_triggers t WHERE t.instance_id=p_instance AND t.kind='db_event'
      AND (public.procurement_workflow_is_table(t.config->>'table') OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.config->'db_events')='array'
          THEN t.config->'db_events' ELSE '[]'::jsonb END) e
        WHERE public.procurement_workflow_is_table(e->>'table'))))
$$;
REVOKE ALL ON FUNCTION public.procurement_workflow_instance_is_private(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Direct authorization calls still require an existing same-site row, including
-- ordinary robots. Membership is explicit even for privileged caller RPCs.
CREATE OR REPLACE FUNCTION public.procurement_workflow_instance_can_read(p_site uuid, p_instance uuid, p_actor uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF public.site_user_has_effective_access(p_site,p_actor) IS NOT TRUE
    OR NOT EXISTS (SELECT 1 FROM public.remote_instances WHERE id=p_instance AND site_id=p_site) THEN
    RETURN false;
  END IF;
  IF NOT public.procurement_workflow_instance_is_private(p_instance) THEN RETURN true; END IF;
  RETURN public.procurement_workflow_actor_can_read(p_site,p_actor);
END $$;

-- Only the base-row policy can trust the candidate row's site/id. All derived
-- tables and the public read RPC retain their existence-checking guard. Existing
-- permissive tenant SELECT and INSERT WITH CHECK policies remain unchanged.
-- Bind the actor internally: clients cannot impersonate another member or call
-- the privileged membership/classification helpers directly. This candidate-row
-- predicate is not an existence-checking RPC; use rls_read for that contract.
CREATE FUNCTION public.procurement_workflow_candidate_can_read(p_site uuid, p_instance uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR p_site IS NULL OR p_instance IS NULL
    OR public.site_user_has_effective_access(p_site,auth.uid()) IS NOT TRUE THEN
    RETURN false;
  END IF;
  IF NOT public.procurement_workflow_instance_is_private(p_instance) THEN RETURN true; END IF;
  RETURN public.procurement_workflow_rls_read(p_site,p_instance);
END $$;
REVOKE ALL ON FUNCTION public.procurement_workflow_candidate_can_read(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.procurement_workflow_candidate_can_read(uuid,uuid) TO authenticated;

ALTER POLICY procurement_workflow_read_guard ON public.remote_instances
USING (public.procurement_workflow_candidate_can_read(site_id,id));

COMMIT;
