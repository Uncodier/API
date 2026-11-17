BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.begin_icp_dispatch(p_id uuid, p_run_id uuid, p_workflow_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.icp_dispatch_runs; r public.icp_mining; claim jsonb;
BEGIN
  IF p_run_id IS NULL OR NULLIF(btrim(p_workflow_id), '') IS NULL THEN RAISE EXCEPTION 'Execution identity required'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(734210, 1);
  SELECT * INTO d FROM public.icp_dispatch_runs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR d.workflow_id IS DISTINCT FROM p_workflow_id THEN RAISE EXCEPTION 'Dispatch workflow mismatch'; END IF;
  IF d.run_id IS NOT NULL AND d.run_id IS DISTINCT FROM p_run_id THEN RAISE EXCEPTION 'Dispatch run mismatch'; END IF;
  IF d.state NOT IN ('reserved', 'running') THEN RETURN jsonb_build_object('acquired', false, 'reason', d.state); END IF;
  IF d.state = 'reserved' THEN
    UPDATE public.icp_dispatch_runs SET run_id = p_run_id, updated_at = clock_timestamp() WHERE id = d.id RETURNING * INTO d;
    claim := public.claim_icp_mining_execution(d.icp_mining_id, d.site_id, p_run_id, p_workflow_id);
    IF (claim->>'acquired')::boolean IS DISTINCT FROM true THEN
      -- Uncertain start never returns its quota/slot. Manual reconciliation only.
      UPDATE public.icp_dispatch_runs SET state = 'blocked', error = 'begin_claim_not_acquired',
        updated_at = clock_timestamp() WHERE id = d.id;
      RETURN jsonb_build_object('acquired', false, 'reason', 'busy');
    END IF;
    SELECT * INTO r FROM public.icp_mining WHERE id = d.icp_mining_id FOR UPDATE;
    UPDATE public.icp_dispatch_runs SET state = 'running', baseline_processed = COALESCE(r.processed_targets, 0),
      baseline_found = COALESCE(r.found_matches, 0), updated_at = clock_timestamp()
      WHERE id = d.id RETURNING * INTO d;
  ELSE
    SELECT * INTO r FROM public.icp_mining WHERE id = d.icp_mining_id FOR UPDATE;
    IF r.execution_run_id IS DISTINCT FROM p_run_id OR r.execution_workflow_id IS DISTINCT FROM p_workflow_id THEN
      RAISE EXCEPTION 'Dispatch execution ownership lost';
    END IF;
  END IF;
  -- Explicit allowlist: never return errors, last_error, criteria or future audit
  -- columns. Same-run retries retain the ORIGINAL baselines and current cursor.
  RETURN jsonb_build_object('acquired', true, 'reservation', to_jsonb(d), 'icp', jsonb_build_object(
    'id', r.id, 'site_id', r.site_id, 'role_query_id', r.role_query_id, 'name', r.name, 'status', r.status,
    'total_targets', r.total_targets, 'processed_targets', r.processed_targets, 'found_matches', r.found_matches,
    'current_page', r.current_page, 'current_page_offset', r.current_page_offset, 'created_at', r.created_at,
    'selected_processed_targets', r.selected_processed_targets, 'checkpoint_version', r.checkpoint_version, 'current_page_snapshot', r.current_page_snapshot));
END $$;

COMMIT;
