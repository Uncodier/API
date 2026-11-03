BEGIN;

-- Sticky instance classification protects payloads AND derived plans/logs/results.
-- Removing a subscription must never make past purchasing data public to members.
CREATE TABLE public.procurement_workflow_private_instances (
  instance_id uuid PRIMARY KEY REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE
);
ALTER TABLE public.procurement_workflow_private_instances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.procurement_workflow_private_instances FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.procurement_workflow_is_table(p_table text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT COALESCE(p_table = ANY(ARRAY[
    'suppliers','supplier_contacts','catalog_item_suppliers','procurement_requests',
    'procurement_tenders','procurement_tender_publications','procurement_tender_participants',
    'procurement_event_approvals','procurement_awards','purchase_orders','procurement_receipts',
    'procurement_replenishment_rules','procurement_replenishment_cases'
  ]), false)
$$;
REVOKE ALL ON FUNCTION public.procurement_workflow_is_table(text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.procurement_workflow_actor_can_read(p_site uuid, p_actor uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  old_claims text := current_setting('request.jwt.claims', true);
  old_sub text := current_setting('request.jwt.claim.sub', true);
  old_role text := current_setting('request.jwt.claim.role', true);
  allowed boolean;
BEGIN
  IF p_actor IS NULL THEN RETURN false; END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',p_actor,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claim.role','',true);
  allowed := public.procurement_tender_access(p_site,'select') IS TRUE
    AND public.site_user_has_effective_access(p_site,p_actor) IS TRUE;
  PERFORM set_config('request.jwt.claims',COALESCE(old_claims,''),true);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(old_sub,''),true);
  PERFORM set_config('request.jwt.claim.role',COALESCE(old_role,''),true);
  RETURN allowed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('request.jwt.claims',COALESCE(old_claims,''),true);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(old_sub,''),true);
  PERFORM set_config('request.jwt.claim.role',COALESCE(old_role,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION public.procurement_workflow_actor_can_read(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.procurement_workflow_actor_can_read(uuid,uuid) TO service_role;

CREATE FUNCTION public.procurement_workflow_instance_can_read(p_site uuid, p_instance uuid, p_actor uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE restricted boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.remote_instances WHERE id=p_instance AND site_id=p_site) THEN
    RETURN false;
  END IF;
  restricted := EXISTS (SELECT 1 FROM public.procurement_workflow_private_instances WHERE instance_id=p_instance)
    OR EXISTS (SELECT 1 FROM public.workflow_triggers t WHERE t.instance_id=p_instance AND t.kind='db_event'
      AND (public.procurement_workflow_is_table(t.config->>'table') OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.config->'db_events')='array'
          THEN t.config->'db_events' ELSE '[]'::jsonb END) e
        WHERE public.procurement_workflow_is_table(e->>'table'))));
  IF NOT restricted THEN RETURN true; END IF;
  RETURN public.procurement_workflow_actor_can_read(p_site,p_actor);
END $$;
REVOKE ALL ON FUNCTION public.procurement_workflow_instance_can_read(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.procurement_workflow_instance_can_read(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.procurement_workflow_rls_read(p_site uuid, p_instance uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.procurement_workflow_instance_can_read(p_site,p_instance,auth.uid())
$$;
REVOKE ALL ON FUNCTION public.procurement_workflow_rls_read(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.procurement_workflow_rls_read(uuid,uuid) TO authenticated;

CREATE FUNCTION public.classify_procurement_workflow_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF public.procurement_workflow_is_table(NEW.payload->>'table') THEN
    IF NOT EXISTS (SELECT 1 FROM public.remote_instances WHERE id=NEW.instance_id AND site_id=NEW.site_id) THEN
      RAISE EXCEPTION 'Procurement workflow tenant mismatch' USING ERRCODE='42501';
    END IF;
    INSERT INTO public.procurement_workflow_private_instances(instance_id,site_id)
      VALUES (NEW.instance_id,NEW.site_id) ON CONFLICT (instance_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.classify_procurement_workflow_run() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER classify_procurement_workflow_run BEFORE INSERT OR UPDATE OF payload,instance_id,site_id
  ON public.workflow_runs FOR EACH ROW EXECUTE FUNCTION public.classify_procurement_workflow_run();

INSERT INTO public.procurement_workflow_private_instances(instance_id,site_id)
  SELECT DISTINCT instance_id,site_id FROM public.workflow_runs
  WHERE public.procurement_workflow_is_table(payload->>'table') ON CONFLICT DO NOTHING;
INSERT INTO public.procurement_workflow_private_instances(instance_id,site_id)
  SELECT DISTINCT p.instance_id,p.site_id FROM public.instance_plans p
  JOIN public.remote_instances i ON i.id=p.instance_id AND i.site_id=p.site_id
  WHERE public.procurement_workflow_is_table(p.metadata#>>'{trigger_payload,table}') ON CONFLICT DO NOTHING;

-- Classify before persisting the first plan, so a concurrent reader cannot see
-- trigger_payload during the interval before workflow_runs is inserted.
CREATE FUNCTION public.procurement_workflow_protect_instance(p_site uuid,p_instance uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid;
BEGIN
  SELECT user_id INTO actor FROM public.remote_instances WHERE id=p_instance AND site_id=p_site;
  IF actor IS NULL OR public.procurement_workflow_actor_can_read(p_site,actor) IS NOT TRUE THEN
    RAISE EXCEPTION 'Procurement workflow actor access denied' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.procurement_workflow_private_instances(instance_id,site_id)
    VALUES(p_instance,p_site) ON CONFLICT (instance_id) DO NOTHING;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.procurement_workflow_protect_instance(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.procurement_workflow_protect_instance(uuid,uuid) TO service_role;

-- Cloud storage is accessed through privileged RPCs; RLS alone cannot protect
-- artifacts generated by a private purchasing workflow.
DO $$ DECLARE definition text; needle text;
BEGIN
  IF to_regprocedure('public.cloud_file_check_scope(uuid,uuid,uuid,uuid)') IS NOT NULL THEN
    definition := pg_get_functiondef('public.cloud_file_check_scope(uuid,uuid,uuid,uuid)'::regprocedure);
    needle := 'OR public.site_user_has_effective_access(p_site_id,p_user_id) IS DISTINCT FROM true';
    IF position(needle IN definition)=0 THEN
      RAISE EXCEPTION 'Cloud scope guard is incompatible with procurement confidentiality migration';
    END IF;
    EXECUTE replace(definition,needle,needle || E'\n    OR public.procurement_workflow_instance_can_read(p_site_id,p_instance_id,p_user_id) IS DISTINCT FROM true');
  END IF;
END $$;

-- RESTRICTIVE policies intersect existing tenant policies rather than replace them.
DO $$ DECLARE target text; instance_column text; BEGIN
  FOREACH target IN ARRAY ARRAY['remote_instances','workflow_runs','workflow_triggers',
    'instance_plans','instance_nodes','instance_logs','instance_context_state','instance_context_memories'] LOOP
    IF to_regclass(format('public.%I',target)) IS NULL THEN CONTINUE; END IF;
    instance_column := CASE WHEN target='remote_instances' THEN 'id' ELSE 'instance_id' END;
    EXECUTE format('CREATE POLICY procurement_workflow_read_guard ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (public.procurement_workflow_rls_read(site_id,%I))',target,instance_column);
  END LOOP;
END $$;

COMMIT;