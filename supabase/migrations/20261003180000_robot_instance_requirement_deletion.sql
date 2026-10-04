-- Makinari only. Forward-only; the companion migration installs the public RPCs.
-- History belongs to requirements, never to an instance merely mentioned by it.
BEGIN;

-- Preserve every other FK/action. Only these reviewed ownership edges cascade.
DO $$
DECLARE edge record; definition text;
BEGIN
  FOR edge IN
    SELECT c.oid, c.conrelid::regclass AS child, c.conname
    FROM pg_catalog.pg_constraint c
    WHERE c.contype = 'f' AND (
      (c.confrelid = 'public.requirements'::regclass AND c.conrelid IN (
        'public.requirement_status'::regclass, 'public.requirement_segments'::regclass,
        'public.campaign_requirements'::regclass,
        'public.catalog_item_requirements'::regclass,
        'public.requirement_migration_lifecycle'::regclass,
        'public.requirement_harness_decisions'::regclass,
        'public.requirement_migration_execution_handoffs'::regclass,
        'public.requirement_migration_reconciliation_resumes'::regclass))
      OR (c.confrelid = 'public.requirement_migration_lifecycle'::regclass AND c.conrelid IN (
        'public.requirement_migration_diagnostics'::regclass,
        'public.requirement_migration_reconciliations'::regclass,
        'public.requirement_migration_execution_handoffs'::regclass))
      OR (c.confrelid = 'public.requirement_migration_reconciliations'::regclass
        AND c.conrelid = 'public.requirement_migration_reconciliation_resumes'::regclass)
    ) AND c.confdeltype <> 'c' AND (
      (c.confrelid = 'public.requirements'::regclass AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = c.conrelid AND attname = 'requirement_id')
      ]::smallint[])
      OR (c.confrelid = 'public.requirement_migration_lifecycle'::regclass AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = c.conrelid AND attname = 'requirement_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = c.conrelid AND attname = 'file')
      ]::smallint[])
      OR (c.confrelid = 'public.requirement_migration_reconciliations'::regclass AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = c.conrelid AND attname = 'receipt_id')
      ]::smallint[])
    )
  LOOP
    definition := pg_catalog.pg_get_constraintdef(edge.oid);
    definition := regexp_replace(definition, ' ON DELETE (NO ACTION|RESTRICT|SET NULL|SET DEFAULT)', '');
    -- Insert before deferrability, if present; preserve update and match actions.
    definition := regexp_replace(definition, '( DEFERRABLE| NOT DEFERRABLE| NOT VALID|$)',
      ' ON DELETE CASCADE\1', 1, 1);
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', edge.child, edge.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', edge.child, edge.conname, definition);
  END LOOP;
END;
$$;

CREATE FUNCTION public.guard_requirement_owned_receipt_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- A real root deletion, not a role, session setting or trigger-depth bypass.
  IF EXISTS (SELECT 1 FROM public.requirements WHERE id = OLD.requirement_id) THEN
    RAISE EXCEPTION 'Requirement history is append-only while its requirement exists' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_requirement_owned_receipt_delete() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER migration_reconciliations_append_only ON public.requirement_migration_reconciliations;
CREATE TRIGGER migration_reconciliations_append_only
  BEFORE UPDATE OR TRUNCATE ON public.requirement_migration_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_migration_reconciliation_mutation();
CREATE TRIGGER migration_reconciliations_root_delete
  BEFORE DELETE ON public.requirement_migration_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.guard_requirement_owned_receipt_delete();
DROP TRIGGER migration_reconciliation_resumes_append_only ON public.requirement_migration_reconciliation_resumes;
CREATE TRIGGER migration_reconciliation_resumes_append_only
  BEFORE UPDATE OR TRUNCATE ON public.requirement_migration_reconciliation_resumes
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_migration_reconciliation_mutation();
CREATE TRIGGER migration_reconciliation_resumes_root_delete
  BEFORE DELETE ON public.requirement_migration_reconciliation_resumes
  FOR EACH ROW EXECUTE FUNCTION public.guard_requirement_owned_receipt_delete();
DROP TRIGGER migration_execution_handoffs_append_only ON public.requirement_migration_execution_handoffs;
CREATE TRIGGER migration_execution_handoffs_append_only
  BEFORE UPDATE OR TRUNCATE ON public.requirement_migration_execution_handoffs
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_migration_execution_handoff_mutation();
CREATE TRIGGER migration_execution_handoffs_root_delete
  BEFORE DELETE ON public.requirement_migration_execution_handoffs
  FOR EACH ROW EXECUTE FUNCTION public.guard_requirement_owned_receipt_delete();

CREATE OR REPLACE FUNCTION public.guard_migration_execution_handoff()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.requirements WHERE id = OLD.requirement_id
  ) THEN RETURN NULL; END IF;
  IF TG_OP <> 'INSERT' AND (OLD.state = 'transferred' OR EXISTS (
    SELECT 1 FROM public.requirement_migration_execution_handoffs h
    WHERE h.requirement_id = OLD.requirement_id AND h.file = OLD.file
  )) THEN
    IF TG_OP <> 'UPDATE' OR OLD.state = 'transferred' OR NEW.state <> 'transferred' THEN
      RAISE EXCEPTION 'Transferred migration lifecycle is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.state = 'transferred' THEN
    IF TG_OP <> 'UPDATE' OR NOT public.migration_execution_handoff_matches(NEW)
      OR NOT EXISTS (SELECT 1 FROM public.requirement_migration_execution_handoffs h
        WHERE h.requirement_id = NEW.requirement_id AND h.file = NEW.file
          AND h.prior_lifecycle = to_jsonb(OLD)) THEN
      RAISE EXCEPTION 'Transferred migration requires its matching immutable receipt' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_migration_execution_handoff() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.guard_requirement_deletion_authority()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Preserve pre-existing system deletion and a real site-root FK cascade. The
  -- built-in role setting is PostgreSQL-authorized SET ROLE, not a caller flag.
  -- Neither exception grants access to the authenticated-only deletion RPCs.
  IF NOT EXISTS (SELECT 1 FROM public.sites WHERE id = OLD.site_id)
    OR (auth.uid() IS NULL AND current_setting('role', true) = 'service_role') THEN
    RETURN OLD;
  END IF;
  IF auth.uid() IS NULL
    OR public.current_user_site_role(OLD.site_id) IS NULL
    OR public.current_user_site_role(OLD.site_id) NOT IN ('owner', 'admin')
    OR public.user_can(OLD.site_id, 'delete') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Requirement deletion requires site owner or administrator permission' USING ERRCODE = 'PT403';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_requirement_deletion_authority() FROM PUBLIC, anon, authenticated, service_role;
-- Replace only the legacy requirements DELETE guard: its membership lookup misses
-- site_ownership. The legacy function and all other tables remain unchanged.
DO $$
DECLARE old_guard record;
BEGIN
  FOR old_guard IN SELECT t.tgname FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE t.tgrelid = 'public.requirements'::regclass AND NOT t.tgisinternal
      AND n.nspname = 'public' AND p.proname = 'check_delete_permission'
      AND t.tgtype = 11
  LOOP
    EXECUTE format('DROP TRIGGER %I ON public.requirements', old_guard.tgname);
  END LOOP;
END;
$$;
CREATE TRIGGER requirement_deletion_authority
  BEFORE DELETE ON public.requirements FOR EACH ROW
  EXECUTE FUNCTION public.guard_requirement_deletion_authority();

CREATE FUNCTION public.guard_robot_deletion_child_authority()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE resource_site uuid;
BEGIN
  IF TG_TABLE_NAME = 'campaign_requirements' THEN
    IF NOT EXISTS (SELECT 1 FROM public.requirements WHERE id = OLD.requirement_id) THEN RETURN OLD; END IF;
    SELECT site_id INTO resource_site FROM public.campaigns WHERE id = OLD.campaign_id;
  ELSE
    IF OLD.instance_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.remote_instances WHERE id = OLD.instance_id
    ) THEN RETURN OLD; END IF;
    resource_site := OLD.site_id;
  END IF;
  IF resource_site IS NULL OR NOT EXISTS (SELECT 1 FROM public.sites WHERE id = resource_site)
    OR (auth.uid() IS NULL AND current_setting('role', true) = 'service_role') THEN RETURN OLD; END IF;
  IF auth.uid() IS NULL OR public.current_user_site_role(resource_site) IS NULL
    OR public.current_user_site_role(resource_site) NOT IN ('owner','admin')
    OR public.user_can(resource_site, 'delete') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Site owner or administrator deletion permission required' USING ERRCODE = 'PT403';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_robot_deletion_child_authority() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER trigger_delete_protection_assets ON public.assets;
CREATE TRIGGER trigger_delete_protection_assets BEFORE DELETE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.guard_robot_deletion_child_authority();
DROP TRIGGER trigger_delete_protection_campaign_requirements ON public.campaign_requirements;
CREATE TRIGGER trigger_delete_protection_campaign_requirements BEFORE DELETE ON public.campaign_requirements
  FOR EACH ROW EXECUTE FUNCTION public.guard_robot_deletion_child_authority();

CREATE FUNCTION public.guard_requirement_instance_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE binding text; bound_site uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id
    AND NEW.metadata->'runner_instance_id' IS NOT DISTINCT FROM OLD.metadata->'runner_instance_id'
    AND NEW.metadata->'assistant_origin_instance_id' IS NOT DISTINCT FROM OLD.metadata->'assistant_origin_instance_id'
  THEN RETURN NEW; END IF;
  FOR binding IN SELECT DISTINCT value FROM unnest(ARRAY[
    NEW.metadata->>'runner_instance_id', NEW.metadata->>'assistant_origin_instance_id'
  ]) AS bindings(value) WHERE value IS NOT NULL ORDER BY value LOOP
    IF binding !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Invalid requirement instance binding' USING ERRCODE = '23514';
    END IF;
    SELECT site_id INTO bound_site FROM public.remote_instances
      WHERE id = binding::uuid FOR KEY SHARE;
    IF NOT FOUND OR bound_site IS DISTINCT FROM NEW.site_id THEN
      RAISE EXCEPTION 'Requirement instance binding is missing or cross-site' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_requirement_instance_binding() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER requirement_instance_binding_guard
  BEFORE INSERT OR UPDATE OF metadata, site_id ON public.requirements
  FOR EACH ROW EXECUTE FUNCTION public.guard_requirement_instance_binding();

CREATE FUNCTION public.guard_instance_plan_requirement_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE binding text := NEW.metadata->>'requirement_id'; bound_site uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id
    AND NEW.instance_id IS NOT DISTINCT FROM OLD.instance_id
    AND NEW.metadata->'requirement_id' IS NOT DISTINCT FROM OLD.metadata->'requirement_id'
  THEN RETURN NEW; END IF;
  IF binding IS NOT NULL THEN
    IF binding !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Invalid plan requirement binding' USING ERRCODE = '23514';
    END IF;
    SELECT site_id INTO bound_site FROM public.requirements WHERE id = binding::uuid FOR KEY SHARE;
    IF NOT FOUND OR bound_site IS DISTINCT FROM NEW.site_id THEN
      RAISE EXCEPTION 'Plan requirement binding is missing or cross-site' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT site_id INTO bound_site FROM public.remote_instances WHERE id = NEW.instance_id FOR KEY SHARE;
  IF NOT FOUND OR bound_site IS DISTINCT FROM NEW.site_id THEN
    RAISE EXCEPTION 'Plan instance binding is missing or cross-site' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_instance_plan_requirement_binding() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER instance_plan_requirement_binding_guard
  BEFORE INSERT OR UPDATE OF metadata, site_id, instance_id ON public.instance_plans
  FOR EACH ROW EXECUTE FUNCTION public.guard_instance_plan_requirement_binding();

CREATE FUNCTION public.guard_requirement_status_instance_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE bound_site uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id
    AND NEW.instance_id IS NOT DISTINCT FROM OLD.instance_id
    AND NEW.requirement_id IS NOT DISTINCT FROM OLD.requirement_id THEN RETURN NEW; END IF;
  SELECT site_id INTO bound_site FROM public.requirements WHERE id = NEW.requirement_id FOR KEY SHARE;
  IF NOT FOUND OR bound_site IS DISTINCT FROM NEW.site_id THEN
    RAISE EXCEPTION 'Requirement status binding is missing or cross-site' USING ERRCODE = '23514';
  END IF;
  IF NEW.instance_id IS NOT NULL THEN
    SELECT site_id INTO bound_site FROM public.remote_instances WHERE id = NEW.instance_id FOR KEY SHARE;
    IF NOT FOUND OR bound_site IS DISTINCT FROM NEW.site_id THEN
      RAISE EXCEPTION 'Requirement status instance is missing or cross-site' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_requirement_status_instance_binding() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER requirement_status_instance_binding_guard
  BEFORE INSERT OR UPDATE OF requirement_id, instance_id, site_id ON public.requirement_status
  FOR EACH ROW EXECUTE FUNCTION public.guard_requirement_status_instance_binding();

CREATE FUNCTION public.guard_instance_requirement_metadata_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE binding text := NEW.metadata->>'requirement_id'; bound_site uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id
    AND NEW.metadata->'requirement_id' IS NOT DISTINCT FROM OLD.metadata->'requirement_id'
  THEN RETURN NEW; END IF;
  IF binding IS NULL THEN RETURN NEW; END IF;
  IF binding !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Invalid instance requirement binding' USING ERRCODE = '23514';
  END IF;
  SELECT site_id INTO bound_site FROM public.requirements WHERE id = binding::uuid FOR KEY SHARE;
  IF NOT FOUND OR bound_site IS DISTINCT FROM NEW.site_id THEN
    RAISE EXCEPTION 'Instance requirement binding is missing or cross-site' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_instance_requirement_metadata_binding() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER instance_requirement_metadata_binding_guard
  BEFORE INSERT OR UPDATE OF metadata, site_id ON public.remote_instances
  FOR EACH ROW EXECUTE FUNCTION public.guard_instance_requirement_metadata_binding();

CREATE FUNCTION public.guard_platform_key_requirement_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE binding text := NEW.metadata->>'requirement_id'; bound_site uuid;
BEGIN
  IF NEW.metadata->>'issued_by' IS DISTINCT FROM 'platform-api.ensure-platform-key'
    OR (TG_OP = 'UPDATE' AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id
      AND NEW.metadata->'requirement_id' IS NOT DISTINCT FROM OLD.metadata->'requirement_id'
      AND NEW.metadata->'issued_by' IS NOT DISTINCT FROM OLD.metadata->'issued_by'
      AND NEW.status IS DISTINCT FROM 'active') THEN RETURN NEW; END IF;
  IF binding IS NULL OR binding !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Invalid platform key requirement binding' USING ERRCODE = '23514';
  END IF;
  SELECT site_id INTO bound_site FROM public.requirements WHERE id = binding::uuid FOR KEY SHARE;
  IF NOT FOUND OR bound_site IS DISTINCT FROM NEW.site_id THEN
    RAISE EXCEPTION 'Platform key requirement binding is missing or cross-site' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_platform_key_requirement_binding() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER platform_key_requirement_binding_guard
  BEFORE INSERT OR UPDATE OF metadata, site_id, status ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_key_requirement_binding();

CREATE FUNCTION public.guard_instance_log_requirement_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE binding text; bound_site uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id
    AND ARRAY[NEW.details->>'requirement_id', NEW.details->>'requirementId',
      NEW.tool_args->>'requirement_id', NEW.tool_args->>'requirementId']
      IS NOT DISTINCT FROM ARRAY[OLD.details->>'requirement_id', OLD.details->>'requirementId',
        OLD.tool_args->>'requirement_id', OLD.tool_args->>'requirementId'] THEN RETURN NEW; END IF;
  FOR binding IN SELECT DISTINCT value FROM unnest(ARRAY[
    NEW.details->>'requirement_id', NEW.details->>'requirementId',
    NEW.tool_args->>'requirement_id', NEW.tool_args->>'requirementId'
  ]) tags(value) WHERE value IS NOT NULL ORDER BY value LOOP
    IF binding !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Invalid log requirement binding' USING ERRCODE = '23514';
    END IF;
    SELECT site_id INTO bound_site FROM public.requirements WHERE id = binding::uuid FOR KEY SHARE;
    IF NOT FOUND OR bound_site IS DISTINCT FROM NEW.site_id THEN
      RAISE EXCEPTION 'Log requirement binding is missing or cross-site' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_instance_log_requirement_binding() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER instance_log_requirement_binding_guard
  BEFORE INSERT OR UPDATE OF details, tool_args, site_id ON public.instance_logs
  FOR EACH ROW EXECUTE FUNCTION public.guard_instance_log_requirement_binding();

CREATE FUNCTION public.guard_cron_outcome_instance_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE requirement_site uuid; instance_site uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.requirement_id IS NOT DISTINCT FROM OLD.requirement_id
    AND NEW.runner_instance_id IS NOT DISTINCT FROM OLD.runner_instance_id THEN RETURN NEW; END IF;
  IF NEW.runner_instance_id IS NULL THEN RETURN NEW; END IF;
  SELECT site_id INTO requirement_site FROM public.requirements WHERE id = NEW.requirement_id FOR KEY SHARE;
  SELECT site_id INTO instance_site FROM public.remote_instances WHERE id = NEW.runner_instance_id FOR KEY SHARE;
  IF NOT FOUND OR requirement_site IS NULL OR requirement_site IS DISTINCT FROM instance_site THEN
    RAISE EXCEPTION 'Cron outcome instance is missing or cross-site' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_cron_outcome_instance_binding() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER cron_outcome_instance_binding_guard
  BEFORE INSERT OR UPDATE OF requirement_id, runner_instance_id ON public.requirement_cron_cycle_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.guard_cron_outcome_instance_binding();

COMMIT;