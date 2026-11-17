-- Preserve all existing quotas, ownership and fairness guards; include pending members.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.reserve_icp_dispatch(
  p_site_id uuid, p_icp_id uuid, p_dispatch_key text, p_workflow_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c public.icp_dispatch_config;
  d public.icp_dispatch_runs;
  r public.icp_mining;
  activity_settings jsonb;
  settings_json jsonb;
  list_ids jsonb;
  target integer := 150;
  research boolean := false;
  all_lists boolean := true;
  candidate_cap integer;
  candidates_used bigint;
  matches_used bigint;
  candidates integer;
  matches integer;
  stamp timestamptz;
  day_utc date;
BEGIN
  IF p_site_id IS NULL OR p_icp_id IS NULL OR NULLIF(btrim(p_dispatch_key), '') IS NULL
    OR NULLIF(btrim(p_workflow_id), '') IS NULL THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_identity');
  END IF;
  -- One transaction lock for ALL reservations, begin, finish and manual claims.
  -- Always acquire it BEFORE config/reservation/ICP row locks. Never use a TTL.
  PERFORM pg_catalog.pg_advisory_xact_lock(734210, 1);
  SELECT * INTO c FROM public.icp_dispatch_config WHERE id FOR SHARE;
  SELECT * INTO d FROM public.icp_dispatch_runs WHERE dispatch_key = p_dispatch_key;
  IF FOUND THEN
    IF (d.site_id, d.icp_mining_id, d.workflow_id) IS DISTINCT FROM (p_site_id, p_icp_id, p_workflow_id) THEN
      RETURN jsonb_build_object('acquired', false, 'reason', 'dispatch_key_conflict');
    END IF;
    RETURN jsonb_build_object('acquired', true, 'reservation', to_jsonb(d));
  END IF;
  IF EXISTS (SELECT 1 FROM public.icp_dispatch_runs WHERE workflow_id = p_workflow_id) THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'workflow_id_conflict');
  END IF;
  IF c.enabled IS DISTINCT FROM true THEN RETURN jsonb_build_object('acquired', false, 'reason', 'disabled'); END IF;
  stamp := clock_timestamp();
  day_utc := (stamp AT TIME ZONE 'UTC')::date;
  PERFORM 1 FROM public.sites WHERE id = p_site_id AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('acquired', false, 'reason', 'site_unavailable'); END IF;

  -- Read authoritative settings for EVERY new reservation. Missing legacy fields
  -- use defaults; malformed controls (including any malformed selected ID) deny.
  SELECT activities INTO activity_settings FROM public.settings WHERE site_id = p_site_id FOR SHARE;
  activity_settings := COALESCE(activity_settings, '{}'::jsonb);
  IF jsonb_typeof(activity_settings) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_settings');
  END IF;
  settings_json := COALESCE(activity_settings->'icp_lead_generation', '{}'::jsonb);
  IF jsonb_typeof(settings_json) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_settings');
  END IF;
  IF settings_json ? 'target_leads' THEN
    IF jsonb_typeof(settings_json->'target_leads') IS DISTINCT FROM 'number' THEN
      RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_settings');
    END IF;
    IF (settings_json->>'target_leads')::numeric NOT BETWEEN 1 AND 3000
      OR trunc((settings_json->>'target_leads')::numeric) <> (settings_json->>'target_leads')::numeric THEN
      RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_settings');
    END IF;
    target := (settings_json->>'target_leads')::numeric::integer;
  END IF;
  IF settings_json ? 'research_enabled' THEN
    IF jsonb_typeof(settings_json->'research_enabled') IS DISTINCT FROM 'boolean' THEN
      RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_settings');
    END IF;
    research := (settings_json->>'research_enabled')::boolean;
  END IF;
  IF settings_json ? 'all_lists' THEN
    IF jsonb_typeof(settings_json->'all_lists') IS DISTINCT FROM 'boolean' THEN
      RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_settings');
    END IF;
    all_lists := (settings_json->>'all_lists')::boolean;
  END IF;
  list_ids := COALESCE(settings_json->'list_ids', '[]'::jsonb);
  IF jsonb_typeof(list_ids) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_settings');
  END IF;
  IF jsonb_array_length(list_ids) > 1000 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(list_ids) AS item(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
      OR (value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_settings'); END IF;
  IF NOT all_lists AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(list_ids) AS item(value) WHERE value::uuid = p_icp_id
  ) THEN RETURN jsonb_build_object('acquired', false, 'reason', 'list_not_selected'); END IF;

  SELECT * INTO r FROM public.icp_mining WHERE id = p_icp_id AND site_id = p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('acquired', false, 'reason', 'list_unavailable'); END IF;
  IF r.status NOT IN ('pending', 'running') THEN RETURN jsonb_build_object('acquired', false, 'reason', 'not_pending'); END IF;
  IF EXISTS (SELECT 1 FROM public.icp_dispatch_runs WHERE site_id = p_site_id AND state IN ('reserved', 'running', 'blocked')) THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'site_busy');
  END IF;
  IF EXISTS (SELECT 1 FROM public.icp_mining WHERE site_id = p_site_id AND execution_active) THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'execution_busy');
  END IF;
  IF (SELECT count(*) FROM public.icp_dispatch_runs WHERE state IN ('reserved', 'running', 'blocked'))
    + (SELECT count(*) FROM public.icp_mining legacy WHERE legacy.execution_active AND NOT EXISTS (
        SELECT 1 FROM public.icp_dispatch_runs owned WHERE owned.icp_mining_id = legacy.id
          AND owned.run_id = legacy.execution_run_id AND owned.state IN ('reserved', 'running', 'blocked')
      )) >= c.max_concurrency THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'global_capacity');
  END IF;
  IF EXISTS (SELECT 1 FROM public.icp_dispatch_site_state WHERE site_id = p_site_id AND next_eligible_at > stamp) THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'site_cooldown');
  END IF;
  IF EXISTS (SELECT 1 FROM public.icp_dispatch_list_state WHERE icp_mining_id = p_icp_id AND next_eligible_at > stamp) THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'list_cooldown');
  END IF;
  candidate_cap := least(c.daily_candidate_limit, target * 10);
  SELECT COALESCE(sum(budget.reserved_candidates), 0),
    COALESCE(sum(CASE WHEN budget.state = 'settled' THEN budget.found ELSE budget.reserved_matches END), 0)
    INTO candidates_used, matches_used FROM public.icp_dispatch_runs budget
    WHERE budget.site_id = p_site_id AND budget.budget_day = day_utc;
  IF matches_used >= target THEN RETURN jsonb_build_object('acquired', false, 'reason', 'match_quota'); END IF;
  IF candidates_used >= candidate_cap THEN RETURN jsonb_build_object('acquired', false, 'reason', 'candidate_quota'); END IF;
  -- total_targets=0 is the pre-fetch/unknown sentinel in the existing schema.
  candidates := least(c.slice_candidates, candidate_cap - candidates_used,
    (SELECT count(*) FROM public.icp_mining_people m WHERE m.icp_mining_id = r.id AND m.processing_status = 'pending')
      + CASE WHEN r.search_exhausted OR COALESCE(r.icp_criteria->>'source' = 'selected_people', false) THEN 0
        WHEN r.total_targets > 0 THEN greatest(0, r.total_targets - (COALESCE(r.processed_targets, 0) - r.selected_processed_targets)) ELSE 10 END);
  IF candidates < 1 THEN RETURN jsonb_build_object('acquired', false, 'reason', 'list_exhausted'); END IF;
  matches := least(candidates, target - matches_used);
  INSERT INTO public.icp_dispatch_runs (site_id, icp_mining_id, dispatch_key, workflow_id,
    budget_day, target_limit, candidate_limit, research_enabled, reserved_candidates, reserved_matches, created_at, updated_at)
    VALUES (p_site_id, p_icp_id, p_dispatch_key, p_workflow_id, day_utc, target, candidate_cap,
      research, candidates, matches, stamp, stamp) RETURNING * INTO d;
  -- Touch fairness at reservation, not completion; lost start responses keep their turn.
  INSERT INTO public.icp_dispatch_site_state (site_id, last_dispatched_at) VALUES (p_site_id, stamp)
    ON CONFLICT (site_id) DO UPDATE SET last_dispatched_at = EXCLUDED.last_dispatched_at;
  INSERT INTO public.icp_dispatch_list_state (icp_mining_id, site_id, last_dispatched_at) VALUES (p_icp_id, p_site_id, stamp)
    ON CONFLICT (icp_mining_id) DO UPDATE SET last_dispatched_at = EXCLUDED.last_dispatched_at;
  RETURN jsonb_build_object('acquired', true, 'reservation', to_jsonb(d));
END $$;

-- Preserve the existing compare-and-swap claim body. The dispatcher guard runs
-- before its row lock/claim and cannot be bypassed by supplying previous_run_id.
COMMIT;
