-- Requires API 20261117220000 selected membership and the existing license helpers.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.icp_mining_people ADD COLUMN processing_status text NOT NULL DEFAULT 'pending'
  CHECK (processing_status IN ('pending', 'completed'));
ALTER TABLE public.icp_mining_people ADD COLUMN outcome text CHECK (outcome IN ('matched', 'no_match', 'needs_review'));
ALTER TABLE public.icp_mining_people ADD COLUMN lead_id uuid REFERENCES public.leads(id);
ALTER TABLE public.icp_mining_people ADD COLUMN processed_at timestamptz;
ALTER TABLE public.icp_mining_people ADD COLUMN checkpoint_version integer;
ALTER TABLE public.icp_mining_people ADD COLUMN processed_run_id uuid;
CREATE INDEX icp_people_pending_idx ON public.icp_mining_people(icp_mining_id, ordinal) WHERE processing_status = 'pending';
ALTER TABLE public.icp_mining ADD COLUMN selected_processed_targets integer NOT NULL DEFAULT 0 CHECK (selected_processed_targets >= 0);
ALTER TABLE public.icp_mining ADD COLUMN search_exhausted boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.guard_selected_icp_progress() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.selected_processed_targets, NEW.search_exhausted) IS DISTINCT FROM (OLD.selected_processed_targets, OLD.search_exhausted)
    AND (current_setting('role', true) IN ('authenticated', 'anon')
      OR NEW.execution_run_id IS NULL
      OR COALESCE(current_setting('app.icp_execution_owner', true), '') IS DISTINCT FROM NEW.execution_run_id::text) THEN
    RAISE EXCEPTION 'Selected mining progress requires its execution owner';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_selected_icp_progress() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_selected_icp_progress BEFORE UPDATE ON public.icp_mining
  FOR EACH ROW EXECUTE FUNCTION public.guard_selected_icp_progress();

-- Identity is always derived from persisted attribution, never a workflow/client actor.
CREATE FUNCTION public.selected_icp_creator_active(p_site uuid, p_creator uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_creator IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.sites s WHERE s.id = p_site AND s.archived_at IS NULL AND (
      s.user_id = p_creator OR EXISTS (SELECT 1 FROM public.site_ownership o WHERE o.site_id = s.id AND o.user_id = p_creator)
      OR EXISTS (SELECT 1 FROM public.site_members m WHERE m.site_id = s.id AND m.user_id = p_creator
        AND m.status = 'active' AND public.site_member_has_effective_license(m.id))
    )
  );
$$;

CREATE FUNCTION public.read_selected_icp_people(p_id uuid, p_site_id uuid, p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.icp_mining; members jsonb; pending integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(734210, 1);
  SELECT * INTO r FROM public.icp_mining WHERE id = p_id AND site_id = p_site_id FOR UPDATE;
  IF NOT FOUND OR NOT r.execution_active OR r.execution_run_id IS DISTINCT FROM p_run_id OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'Selected mining execution ownership lost';
  END IF;
  SELECT count(*) INTO pending FROM public.icp_mining_people WHERE icp_mining_id = p_id AND site_id = p_site_id AND processing_status = 'pending';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ordinal', m.ordinal::text, 'person_id', m.person_id, 'created_by', m.created_by) ORDER BY m.ordinal), '[]'::jsonb)
    INTO members FROM (SELECT * FROM public.icp_mining_people WHERE icp_mining_id = p_id AND site_id = p_site_id
      AND processing_status = 'pending' ORDER BY ordinal LIMIT 10) m;
  -- Fail closed, not skip/reassign a revoked creator's persisted selection.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(members) m
    WHERE NOT public.selected_icp_creator_active(p_site_id, (m->>'created_by')::uuid)) THEN
    RAISE EXCEPTION 'Selected member creator has no active site license';
  END IF;
  RETURN jsonb_build_object('selectedOnly', COALESCE(r.icp_criteria->>'source' = 'selected_people', false),
    'searchExhausted', r.search_exhausted, 'pending', pending, 'members', members);
END $$;

CREATE FUNCTION public.get_selected_icp_member(p_id uuid, p_site_id uuid, p_run_id uuid, p_ordinal bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE state jsonb; member jsonb;
BEGIN
  state := public.read_selected_icp_people(p_id, p_site_id, p_run_id);
  SELECT m INTO member FROM jsonb_array_elements(state->'members') m WHERE (m->>'ordinal')::bigint = p_ordinal;
  IF member IS NULL THEN RAISE EXCEPTION 'Selected member is not pending in this execution'; END IF;
  RETURN member;
END $$;

CREATE FUNCTION public.acknowledge_selected_icp_person(p_id uuid, p_site_id uuid, p_run_id uuid,
  p_ordinal bigint, p_version integer, p_lead_id uuid, p_outcome text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.icp_mining; m public.icp_mining_people; processed integer; match_count integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(734210, 1);
  SELECT * INTO r FROM public.icp_mining WHERE id = p_id AND site_id = p_site_id FOR UPDATE;
  IF NOT FOUND OR r.execution_run_id IS DISTINCT FROM p_run_id OR p_run_id IS NULL THEN RAISE EXCEPTION 'Selected mining ownership lost'; END IF;
  SELECT * INTO m FROM public.icp_mining_people WHERE ordinal = p_ordinal AND icp_mining_id = p_id AND site_id = p_site_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Selected member unavailable'; END IF;
  IF m.processing_status = 'completed' THEN
    IF m.processed_run_id IS DISTINCT FROM p_run_id OR m.checkpoint_version IS DISTINCT FROM p_version
      OR m.lead_id IS DISTINCT FROM p_lead_id OR m.outcome IS DISTINCT FROM p_outcome THEN RAISE EXCEPTION 'Stale selected member acknowledgement'; END IF;
    RETURN jsonb_build_object('version', r.checkpoint_version, 'processed', r.processed_targets, 'found', r.found_matches);
  END IF;
  IF NOT r.execution_active OR p_version IS NULL OR p_version <> r.checkpoint_version + 1
    OR NOT public.selected_icp_creator_active(p_site_id, m.created_by) THEN RAISE EXCEPTION 'Selected member owner/version/license lost'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('matched', 'no_match', 'needs_review')
    OR (p_outcome = 'matched') IS DISTINCT FROM (p_lead_id IS NOT NULL) THEN RAISE EXCEPTION 'Invalid selected outcome'; END IF;
  IF p_lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.leads WHERE id = p_lead_id AND site_id = p_site_id) THEN
    RAISE EXCEPTION 'Selected lead does not belong to site';
  END IF;
  processed := COALESCE(r.processed_targets, 0) + 1;
  match_count := COALESCE(r.found_matches, 0) + CASE WHEN p_lead_id IS NULL THEN 0 ELSE 1 END;
  -- Reuse the actual reservation-budget and owner/version checkpoint guard.
  PERFORM public.checkpoint_icp_mining_execution(p_id, p_site_id, p_run_id, p_version, processed, match_count,
    COALESCE(r.current_page, 0), COALESCE(r.current_page_offset, 0), NULL, 'running', r.current_page_snapshot, '[]'::jsonb);
  UPDATE public.icp_mining SET selected_processed_targets = selected_processed_targets + 1 WHERE id = p_id;
  UPDATE public.icp_mining_people SET processing_status = 'completed', outcome = p_outcome, lead_id = p_lead_id,
    processed_at = now(), processed_run_id = p_run_id, checkpoint_version = p_version WHERE ordinal = p_ordinal;
  RETURN jsonb_build_object('version', p_version, 'processed', processed, 'found', match_count);
END $$;

-- Finalize under the same parent lock as append: an append racing exhaustion
-- cannot be overwritten as completed. Search cursor/snapshot are never reset.
CREATE FUNCTION public.finalize_selected_icp_slice(p_id uuid, p_site_id uuid, p_run_id uuid, p_search_exhausted boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.icp_mining; exhausted boolean;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(734210, 1);
  SELECT * INTO r FROM public.icp_mining WHERE id = p_id AND site_id = p_site_id FOR UPDATE;
  IF NOT FOUND OR r.execution_run_id IS DISTINCT FROM p_run_id OR p_run_id IS NULL OR r.execution_active THEN
    RAISE EXCEPTION 'Selected slice must release its owned checkpoint before finalization';
  END IF;
  exhausted := (COALESCE(r.icp_criteria->>'source' = 'selected_people', false) OR r.search_exhausted OR p_search_exhausted)
    AND NOT EXISTS (SELECT 1 FROM public.icp_mining_people WHERE icp_mining_id = p_id AND processing_status = 'pending');
  PERFORM pg_catalog.set_config('app.icp_execution_owner', p_run_id::text, true);
  UPDATE public.icp_mining SET search_exhausted = search_exhausted OR p_search_exhausted,
    status = CASE WHEN exhausted THEN 'completed' ELSE 'pending' END,
    finished_at = CASE WHEN exhausted THEN now() ELSE NULL END WHERE id = p_id;
  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION public.selected_icp_creator_active(uuid, uuid),
  public.read_selected_icp_people(uuid, uuid, uuid), public.get_selected_icp_member(uuid, uuid, uuid, bigint),
  public.acknowledge_selected_icp_person(uuid, uuid, uuid, bigint, integer, uuid, text),
  public.finalize_selected_icp_slice(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.selected_icp_creator_active(uuid, uuid),
  public.read_selected_icp_people(uuid, uuid, uuid), public.get_selected_icp_member(uuid, uuid, uuid, bigint),
  public.acknowledge_selected_icp_person(uuid, uuid, uuid, bigint, integer, uuid, text),
  public.finalize_selected_icp_slice(uuid, uuid, uuid, boolean) TO service_role;
COMMIT;