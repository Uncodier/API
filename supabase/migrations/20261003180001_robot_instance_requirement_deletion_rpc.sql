-- Makinari only. Requires 20261003180000. No remote provider side effects.
BEGIN;

-- Discovery is deliberately wider than ownership. Historical/cross-instance
-- references are conflicts, never authority to delete somebody else's work.
CREATE FUNCTION public.robot_instance_requirement_candidates(p_instance_id uuid)
RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ids uuid[]; binding text;
BEGIN
  FOR binding IN
    SELECT metadata->>'requirement_id' FROM public.remote_instances WHERE id = p_instance_id
    UNION SELECT metadata->>'requirement_id' FROM public.instance_plans WHERE instance_id = p_instance_id
    UNION SELECT value FROM public.instance_logs l CROSS JOIN LATERAL unnest(ARRAY[
      l.details->>'requirement_id', l.details->>'requirementId',
      l.tool_args->>'requirement_id', l.tool_args->>'requirementId'
    ]) tags(value) WHERE l.instance_id = p_instance_id
  LOOP
    IF binding IS NOT NULL AND binding !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Ambiguous requirement association' USING ERRCODE = 'PT409';
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(DISTINCT id ORDER BY id), '{}'::uuid[]) INTO ids FROM (
    SELECT id FROM public.requirements WHERE lower(metadata->>'runner_instance_id') = p_instance_id::text
      OR lower(metadata->>'assistant_origin_instance_id') = p_instance_id::text
    UNION SELECT (metadata->>'requirement_id')::uuid FROM public.remote_instances WHERE id = p_instance_id
    UNION SELECT (metadata->>'requirement_id')::uuid FROM public.instance_plans WHERE instance_id = p_instance_id
    UNION SELECT requirement_id FROM public.requirement_status WHERE instance_id = p_instance_id
    UNION SELECT requirement_id FROM public.requirement_harness_decisions WHERE instance_id = p_instance_id
    UNION SELECT requirement_id FROM public.requirement_migration_reconciliations WHERE instance_id = p_instance_id
    UNION SELECT requirement_id FROM public.requirement_migration_execution_handoffs WHERE instance_id = p_instance_id
    UNION SELECT requirement_id FROM public.catalog_item_requirements WHERE instance_id = p_instance_id
    UNION SELECT requirement_id FROM public.requirement_cron_cycle_outcomes WHERE runner_instance_id = p_instance_id
    UNION SELECT value::uuid FROM public.instance_logs l CROSS JOIN LATERAL unnest(ARRAY[
      l.details->>'requirement_id', l.details->>'requirementId',
      l.tool_args->>'requirement_id', l.tool_args->>'requirementId'
    ]) tags(value) WHERE l.instance_id = p_instance_id
    UNION SELECT r.requirement_id FROM public.requirement_user_action_receipts r
      JOIN public.instance_logs l ON l.id = r.action_id WHERE l.instance_id = p_instance_id
  ) candidates WHERE id IS NOT NULL;
  IF cardinality(ids) > 1000 THEN
    RAISE EXCEPTION 'Requirement deletion scope exceeds the safety limit' USING ERRCODE = 'PT409';
  END IF;
  RETURN ids;
END;
$$;
REVOKE ALL ON FUNCTION public.robot_instance_requirement_candidates(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_robot_instance_deletion_scope(p_instance_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE i public.remote_instances%ROWTYPE; ids uuid[]; provider text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = 'PT401';
  END IF;
  SELECT * INTO i FROM public.remote_instances WHERE id = p_instance_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Instance not found' USING ERRCODE = 'PT404'; END IF;
  IF public.current_user_site_role(i.site_id) IS NULL
    OR public.current_user_site_role(i.site_id) NOT IN ('owner','admin')
    OR public.user_can(i.site_id, 'delete') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Site owner or administrator deletion permission required' USING ERRCODE = 'PT403';
  END IF;
  ids := public.robot_instance_requirement_candidates(i.id);
  IF EXISTS (
    SELECT 1 FROM unnest(ids) candidate(id) LEFT JOIN public.requirements r USING (id)
    WHERE r.id IS NULL OR r.site_id IS DISTINCT FROM i.site_id OR NOT COALESCE((
      (lower(r.metadata->>'runner_instance_id') = i.id::text
        AND (r.metadata->>'assistant_origin_instance_id' IS NULL
          OR lower(r.metadata->>'assistant_origin_instance_id') = i.id::text))
      OR (r.metadata->>'runner_instance_id' IS NULL
        AND lower(r.metadata->>'assistant_origin_instance_id') = i.id::text)
    ), false)
  ) THEN RAISE EXCEPTION 'Requirements are missing, shared, cross-site or ambiguously owned' USING ERRCODE = 'PT409'; END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT requirement_id, instance_id, site_id FROM public.requirement_status
      UNION ALL SELECT requirement_id, instance_id, site_id FROM public.requirement_harness_decisions
      UNION ALL SELECT requirement_id, instance_id, site_id FROM public.requirement_migration_reconciliations
      UNION ALL SELECT requirement_id, instance_id, site_id FROM public.requirement_migration_execution_handoffs
      UNION ALL SELECT requirement_id, instance_id, site_id FROM public.catalog_item_requirements
    ) history WHERE requirement_id = ANY(ids)
      AND (site_id IS DISTINCT FROM i.site_id OR (instance_id IS NOT NULL AND instance_id <> i.id))
  ) OR EXISTS (
    SELECT 1 FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = ANY(ids) AND runner_instance_id IS NOT NULL AND runner_instance_id <> i.id
  ) OR EXISTS (
    SELECT 1 FROM public.requirement_user_action_receipts r JOIN public.instance_logs l ON l.id = r.action_id
    WHERE r.requirement_id = ANY(ids) AND (l.instance_id <> i.id OR l.site_id IS DISTINCT FROM i.site_id)
  ) OR EXISTS (
    SELECT 1 FROM public.requirement_migration_reconciliation_resumes s
      JOIN public.requirement_migration_reconciliations r ON r.id = s.receipt_id
    WHERE (r.requirement_id = ANY(ids) OR s.requirement_id = ANY(ids))
      AND r.requirement_id IS DISTINCT FROM s.requirement_id
  ) OR EXISTS (
    SELECT 1 FROM public.remote_instances other WHERE other.id <> i.id
      AND lower(other.metadata->>'requirement_id') = ANY(ids::text[])
  ) OR EXISTS (
    SELECT 1 FROM public.instance_plans p
    WHERE (p.instance_id = i.id OR lower(p.metadata->>'requirement_id') = ANY(ids::text[]))
      AND (p.instance_id <> i.id OR p.site_id IS DISTINCT FROM i.site_id)
  ) OR EXISTS (
    SELECT 1 FROM public.instance_plans child JOIN public.instance_plans parent ON child.parent_plan_id = parent.id
    WHERE parent.instance_id = i.id AND (child.instance_id <> i.id OR child.site_id IS DISTINCT FROM i.site_id)
  ) OR EXISTS (
    SELECT 1 FROM public.instance_logs l WHERE l.instance_id = i.id AND l.site_id IS DISTINCT FROM i.site_id
  ) OR EXISTS (
    SELECT 1 FROM public.instance_logs l CROSS JOIN LATERAL unnest(ARRAY[
      l.details->>'requirement_id', l.details->>'requirementId',
      l.tool_args->>'requirement_id', l.tool_args->>'requirementId'
    ]) tags(value) WHERE l.instance_id <> i.id AND lower(value) = ANY(ids::text[])
  ) OR EXISTS (
    SELECT 1 FROM public.instance_logs child JOIN public.instance_logs parent ON child.parent_log_id = parent.id
    WHERE parent.instance_id = i.id AND (child.instance_id <> i.id OR child.site_id IS DISTINCT FROM i.site_id)
  ) OR EXISTS (
    SELECT 1 FROM public.assets WHERE instance_id = i.id AND site_id IS DISTINCT FROM i.site_id
  ) OR EXISTS (
    SELECT 1 FROM public.assets a WHERE a.instance_id = i.id AND (
      EXISTS (SELECT 1 FROM public.agent_assets WHERE asset_id = a.id)
      OR EXISTS (SELECT 1 FROM public.content_assets WHERE asset_id = a.id)
      OR EXISTS (SELECT 1 FROM public.requirement_status s WHERE s.asset_id = a.id
        AND (NOT s.requirement_id = ANY(ids) OR s.site_id IS DISTINCT FROM i.site_id
          OR (s.instance_id IS NOT NULL AND s.instance_id <> i.id))))
  ) OR EXISTS (
    SELECT 1 FROM public.workflow_triggers t
    WHERE (t.instance_id = i.id OR t.template_plan_id IN (SELECT id FROM public.instance_plans WHERE instance_id = i.id))
      AND (t.instance_id <> i.id OR t.site_id IS DISTINCT FROM i.site_id)
  ) OR EXISTS (
    SELECT 1 FROM public.workflow_runs w
    WHERE (w.instance_id = i.id
      OR w.run_plan_id IN (SELECT id FROM public.instance_plans WHERE instance_id = i.id)
      OR w.template_plan_id IN (SELECT id FROM public.instance_plans WHERE instance_id = i.id)
      OR w.trigger_id IN (SELECT id FROM public.workflow_triggers WHERE instance_id = i.id))
      AND (w.instance_id <> i.id OR w.site_id IS DISTINCT FROM i.site_id)
  ) OR EXISTS (
    SELECT 1 FROM public.instance_nodes n WHERE n.instance_id = i.id AND n.site_id IS DISTINCT FROM i.site_id
  ) OR EXISTS (
    SELECT 1 FROM public.campaign_requirements cr JOIN public.campaigns c ON c.id = cr.campaign_id
    WHERE cr.requirement_id = ANY(ids) AND c.site_id IS DISTINCT FROM i.site_id
  ) THEN RAISE EXCEPTION 'Requirement history or plans are shared across instances or sites' USING ERRCODE = 'PT409'; END IF;

  -- Bounded v1: no revocation or inferred lease expiry. Quiesce/reconcile first.
  -- Legacy cosmetic running with no provider ID is admissible only when none of
  -- the persisted execution signals below are present. Never infer a provider.
  IF COALESCE(i.status, '') NOT IN ('pending','uninstantiated','paused','stopped','error','running')
    OR (i.status = 'running' AND i.provider_instance_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.requirements r WHERE r.id = ANY(ids)
      AND (r.cron_lock_active IS TRUE OR r.cron_lock_run_id IS NOT NULL OR r.cron_lock_expires_at IS NOT NULL
        OR NULLIF(r.metadata->>'active_sandbox_id','') IS NOT NULL
        OR NULLIF(r.metadata->>'sandbox_id','') IS NOT NULL))
    OR EXISTS (SELECT 1 FROM public.instance_plans p WHERE p.instance_id = i.id
      AND (p.status IN ('in_progress','in-progress','active','running')
        OR NULLIF(p.metadata->>'active_sandbox_id','') IS NOT NULL
        OR NULLIF(p.metadata->>'sandbox_id','') IS NOT NULL OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.steps) = 'array' THEN p.steps ELSE '[]'::jsonb END) s
        WHERE s->>'status' IN ('in_progress','in-progress','active','running'))))
    OR EXISTS (SELECT 1 FROM public.instance_logs l WHERE l.instance_id = i.id
      AND l.log_type = 'user_action' AND l.details->>'status' = 'running')
    OR EXISTS (SELECT 1 FROM public.instance_nodes WHERE instance_id = i.id AND status IN ('running','in_progress','active'))
    OR EXISTS (SELECT 1 FROM public.workflow_runs WHERE instance_id = i.id AND status IN ('pending','in_progress','running','active'))
    OR EXISTS (SELECT 1 FROM public.workflow_triggers WHERE instance_id = i.id AND enabled IS TRUE)
    OR EXISTS (SELECT 1 FROM (
      SELECT DISTINCT ON (requirement_id) stage, active_sandbox_id FROM public.requirement_status
      WHERE requirement_id = ANY(ids) ORDER BY requirement_id, updated_at DESC, id DESC
    ) latest WHERE latest.stage IN ('in-progress','running','active')
      AND NULLIF(latest.active_sandbox_id,'') IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.requirement_migration_diagnostics d WHERE d.requirement_id = ANY(ids)
      AND d.state IN ('running','followup_reviewing'))
    OR NULLIF(i.metadata->>'active_sandbox_id','') IS NOT NULL
    OR NULLIF(i.metadata->>'sandbox_id','') IS NOT NULL
    OR NULLIF(i.configuration->>'active_sandbox_id','') IS NOT NULL
    OR NULLIF(i.configuration->>'sandbox_id','') IS NOT NULL
  THEN RAISE EXCEPTION 'Execution must be stopped and reconciled before deletion' USING ERRCODE = 'PT409'; END IF;
  IF (SELECT count(DISTINCT value) FROM unnest(ARRAY[
    to_jsonb(i)->>'provider', i.metadata->>'provider', i.configuration->>'provider'
  ]) providers(value) WHERE value IS NOT NULL) > 1 THEN
    RAISE EXCEPTION 'Provider identity is ambiguous' USING ERRCODE = 'PT409';
  END IF;
  provider := COALESCE(to_jsonb(i)->>'provider', i.metadata->>'provider', i.configuration->>'provider');
  RETURN jsonb_build_object('instance_id', i.id, 'site_id', i.site_id, 'requirement_ids', ids,
    'provider', provider, 'provider_instance_id', i.provider_instance_id, 'status', i.status);
END;
$$;
REVOKE ALL ON FUNCTION public.get_robot_instance_deletion_scope(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_robot_instance_deletion_scope(uuid) TO authenticated;

CREATE FUNCTION public.delete_robot_instance_with_requirements(
  p_instance_id uuid, p_expected_requirement_ids uuid[], p_expected_provider text,
  p_expected_provider_instance_id text, p_expected_status text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '5s' AS $$
DECLARE before_scope jsonb; current_scope jsonb; ids uuid[]; expected uuid[]; deleted_count bigint;
BEGIN
  before_scope := public.get_robot_instance_deletion_scope(p_instance_id);
  -- The scheduler takes this same mutex before requirement row locks.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('requirement-cron-global-capacity', 0));
  IF p_expected_requirement_ids IS NULL OR array_position(p_expected_requirement_ids, NULL) IS NOT NULL
    OR cardinality(p_expected_requirement_ids) > 1000 THEN
    RAISE EXCEPTION 'An exact expected requirement set is required' USING ERRCODE = 'PT409';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT id ORDER BY id), '{}'::uuid[]) INTO expected FROM unnest(p_expected_requirement_ids) id;
  IF cardinality(expected) <> cardinality(p_expected_requirement_ids) THEN
    RAISE EXCEPTION 'Expected requirement IDs must be unique' USING ERRCODE = 'PT409';
  END IF;
  ids := public.robot_instance_requirement_candidates(p_instance_id);
  IF ids IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Requirement deletion scope changed' USING ERRCODE = 'PT409';
  END IF;
  PERFORM 1 FROM public.requirements WHERE id = ANY(ids) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.requirement_migration_lifecycle WHERE requirement_id = ANY(ids) ORDER BY requirement_id, file FOR UPDATE;
  PERFORM 1 FROM public.requirement_migration_diagnostics WHERE requirement_id = ANY(ids) ORDER BY requirement_id, file FOR UPDATE;
  PERFORM 1 FROM public.remote_instances WHERE id = p_instance_id FOR UPDATE;
  PERFORM 1 FROM public.instance_plans WHERE instance_id = p_instance_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.workflow_triggers WHERE instance_id = p_instance_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.workflow_runs WHERE instance_id = p_instance_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.instance_nodes WHERE instance_id = p_instance_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.instance_logs WHERE instance_id = p_instance_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.requirement_status WHERE requirement_id = ANY(ids) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.assets WHERE instance_id = p_instance_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.catalog_item_requirements WHERE requirement_id = ANY(ids) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.campaign_requirements WHERE requirement_id = ANY(ids) ORDER BY campaign_id, requirement_id FOR UPDATE;
  -- Binding triggers take KEY SHARE on their real parents. New bindings either
  -- commit before this lock and appear here, or fail after their parent is gone.
  current_scope := public.get_robot_instance_deletion_scope(p_instance_id);
  IF current_scope->'requirement_ids' IS DISTINCT FROM to_jsonb(expected)
    OR current_scope->>'provider' IS DISTINCT FROM p_expected_provider
    OR current_scope->>'provider_instance_id' IS DISTINCT FROM p_expected_provider_instance_id
    OR current_scope->>'status' IS DISTINCT FROM p_expected_status
    OR current_scope->>'site_id' IS DISTINCT FROM before_scope->>'site_id' THEN
    RAISE EXCEPTION 'Requirement or provider deletion scope changed' USING ERRCODE = 'PT409';
  END IF;
  UPDATE public.api_keys SET status = 'revoked'
    WHERE site_id = (current_scope->>'site_id')::uuid
      AND metadata->>'issued_by' = 'platform-api.ensure-platform-key'
      AND lower(metadata->>'requirement_id') = ANY(ids::text[]);
  DELETE FROM public.requirements WHERE id = ANY(ids);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  IF deleted_count <> cardinality(ids) THEN
    RAISE EXCEPTION 'Not every expected requirement was deleted' USING ERRCODE = 'PT409';
  END IF;
  DELETE FROM public.instance_logs WHERE instance_id = p_instance_id;
  DELETE FROM public.remote_instances WHERE id = p_instance_id;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.requirements WHERE id = ANY(ids))
    OR EXISTS (SELECT 1 FROM public.remote_instances WHERE id = p_instance_id) THEN
    RAISE EXCEPTION 'Instance deletion was not completed' USING ERRCODE = 'PT409';
  END IF;
  -- Unexpected FK/guard failures propagate and roll back this entire statement.
  RETURN jsonb_build_object('instance_id', p_instance_id, 'deleted_requirement_ids', ids);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_robot_instance_with_requirements(uuid, uuid[], text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_robot_instance_with_requirements(uuid, uuid[], text, text, text) TO authenticated;

COMMIT;