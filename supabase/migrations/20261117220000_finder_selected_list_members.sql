BEGIN;
SET LOCAL lock_timeout = '5s';

-- Provider identities are opaque strings, not application UUIDs. Sequence gaps
-- are expected: workers order by ordinal, never treat it as a dense array index.
CREATE TABLE public.icp_mining_people (
  ordinal bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  icp_mining_id uuid NOT NULL REFERENCES public.icp_mining(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id),
  person_id text NOT NULL CHECK (person_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (icp_mining_id, person_id)
);
CREATE INDEX icp_mining_people_list_ordinal ON public.icp_mining_people(icp_mining_id, ordinal);
ALTER TABLE public.icp_mining_people ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.icp_mining_people FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.icp_mining_people TO authenticated, service_role;
CREATE POLICY finder_selected_people_read ON public.icp_mining_people FOR SELECT TO authenticated
  USING (public.user_can(site_id, 'select') IS TRUE AND EXISTS (
    SELECT 1 FROM public.icp_mining m WHERE m.id = icp_mining_id AND m.site_id = icp_mining_people.site_id
  ));
CREATE POLICY finder_selected_people_worker_read ON public.icp_mining_people FOR SELECT TO service_role USING (true);

-- Private durable receipts survive completed lists and prevent create replay.
-- No browser table grants: authorization is freshly checked even on a replay.
CREATE TABLE public.finder_selected_list_requests (
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  payload jsonb NOT NULL,
  -- Keep a tombstone after list deletion: a retry must not recreate it.
  list_id uuid NOT NULL,
  added_count integer NOT NULL CHECK (added_count BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, request_id)
);
ALTER TABLE public.finder_selected_list_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.finder_selected_list_requests FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.finder_selected_list_metadata(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('id', id, 'site_id', site_id, 'name', name,
    'status', status, 'total_targets', total_targets, 'created_at', created_at)
  FROM public.icp_mining WHERE id = p_id
$$;
REVOKE ALL ON FUNCTION public.finder_selected_list_metadata(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.finder_validate_selected_people(p_ids text[]) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 100 OR EXISTS (
    SELECT 1 FROM unnest(p_ids) AS v(id) WHERE id IS NULL OR id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
  ) THEN RAISE EXCEPTION 'Invalid provider identities' USING ERRCODE = '22023'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.finder_validate_selected_people(text[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.finder_create_selected_list(p_site_id uuid, p_name text, p_person_ids text[], p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor uuid := auth.uid(); receipt public.finder_selected_list_requests;
  payload jsonb; list_id uuid; query_id uuid; added integer;
BEGIN
  IF actor IS NULL OR current_setting('role', true) IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.finder_validate_selected_people(p_person_ids);
  IF p_request_id IS NULL OR p_site_id IS NULL OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200
    OR p_name ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid selected list request' USING ERRCODE = '22023'; END IF;
  IF public.finder_list_row_access(p_site_id, actor) IS NOT TRUE
    OR public.user_can(p_site_id, 'insert') IS NOT TRUE
    OR public.current_user_has_site_location_restrictions(p_site_id) IS DISTINCT FROM false
    OR public.current_user_has_location_restrictions() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'List creation denied' USING ERRCODE = '42501';
  END IF;
  payload := jsonb_build_object('operation', 'create', 'site_id', p_site_id, 'name', btrim(p_name), 'person_ids', to_jsonb(p_person_ids));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text || ':' || p_request_id::text, 0));
  SELECT * INTO receipt FROM public.finder_selected_list_requests WHERE actor_id = actor AND request_id = p_request_id;
  IF FOUND THEN
    IF receipt.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE = '23505'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.icp_mining m WHERE m.id = receipt.list_id
      AND public.finder_list_row_access(m.site_id, m.user_id) IS TRUE) THEN
      RAISE EXCEPTION 'List not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN jsonb_build_object('list', public.finder_selected_list_metadata(receipt.list_id), 'added_count', receipt.added_count);
  END IF;
  -- Nonempty, uniquely scoped placeholder is never sent to provider search by
  -- selected-aware workers. Do not reuse another actor's role query or filters.
  INSERT INTO public.role_queries(query) VALUES (jsonb_build_object(
    'person_id', '__selected_people_only__', 'page', 0, 'selected_request_id', p_request_id, 'selected_actor_id', actor)) RETURNING id INTO query_id;
  INSERT INTO public.icp_mining(site_id, user_id, role_query_id, name, icp_criteria, total_targets)
    VALUES (p_site_id, actor, query_id, btrim(p_name), jsonb_build_object(
      'source', 'selected_people', 'site_id', p_site_id, 'user_id', actor, 'request_id', p_request_id),
      (SELECT count(DISTINCT id) FROM unnest(p_person_ids) AS v(id))) RETURNING id INTO list_id;
  INSERT INTO public.icp_mining_people(icp_mining_id, site_id, person_id, created_by)
    SELECT list_id, p_site_id, id, actor FROM unnest(p_person_ids) WITH ORDINALITY AS v(id, position)
    GROUP BY id ORDER BY min(position);
  GET DIAGNOSTICS added = ROW_COUNT;
  INSERT INTO public.finder_selected_list_requests(actor_id, request_id, payload, list_id, added_count)
    VALUES (actor, p_request_id, payload, list_id, added);
  RETURN jsonb_build_object('list', public.finder_selected_list_metadata(list_id), 'added_count', added);
END $$;

CREATE FUNCTION public.finder_append_selected_people(p_list_id uuid, p_site_id uuid, p_person_ids text[], p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor uuid := auth.uid(); r public.icp_mining; receipt public.finder_selected_list_requests;
  payload jsonb; added integer; previous_owner text;
BEGIN
  IF actor IS NULL OR current_setting('role', true) IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.finder_validate_selected_people(p_person_ids);
  IF p_request_id IS NULL OR p_list_id IS NULL OR p_site_id IS NULL THEN
    RAISE EXCEPTION 'Invalid selected list request' USING ERRCODE = '22023';
  END IF;
  -- Receipt lock precedes the parent lock consistently; checkpoint writers only
  -- lock the parent. Membership and pending admission commit in one transaction.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text || ':' || p_request_id::text, 0));
  SELECT * INTO r FROM public.icp_mining WHERE id = p_list_id AND site_id = p_site_id FOR UPDATE;
  IF NOT FOUND OR public.finder_list_row_access(r.site_id, r.user_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'List not found' USING ERRCODE = 'P0002';
  END IF;
  IF public.user_can(r.site_id, 'update') IS NOT TRUE
    OR public.current_user_has_site_location_restrictions(r.site_id) IS DISTINCT FROM false
    OR public.current_user_has_location_restrictions() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'List update denied' USING ERRCODE = '42501';
  END IF;
  payload := jsonb_build_object('operation', 'append', 'site_id', p_site_id, 'list_id', p_list_id, 'person_ids', to_jsonb(p_person_ids));
  SELECT * INTO receipt FROM public.finder_selected_list_requests WHERE actor_id = actor AND request_id = p_request_id;
  IF FOUND THEN
    IF receipt.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('list', public.finder_selected_list_metadata(p_list_id), 'added_count', receipt.added_count);
  END IF;
  INSERT INTO public.icp_mining_people(icp_mining_id, site_id, person_id, created_by)
    SELECT r.id, r.site_id, id, actor FROM unnest(p_person_ids) WITH ORDINALITY AS v(id, position)
    GROUP BY id ORDER BY min(position) ON CONFLICT (icp_mining_id, person_id) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  IF added > 0 THEN
    -- Canonical execution guard includes total/status. This narrow RPC is allowed
    -- to change only membership accounting/admission under its parent row lock;
    -- never clear ownership, reset cursors, or checkpoint an active execution.
    previous_owner := pg_catalog.current_setting('app.icp_execution_owner', true);
    PERFORM pg_catalog.set_config('app.icp_execution_owner', coalesce(r.execution_run_id::text, ''), true);
    UPDATE public.icp_mining SET
      total_targets = CASE WHEN icp_criteria->>'source' = 'selected_people' THEN coalesce(total_targets, 0) + added ELSE total_targets END,
      status = CASE WHEN status = 'completed' AND execution_active = false THEN 'pending' ELSE status END
      WHERE id = r.id;
    PERFORM pg_catalog.set_config('app.icp_execution_owner', coalesce(previous_owner, ''), true);
  END IF;
  INSERT INTO public.finder_selected_list_requests(actor_id, request_id, payload, list_id, added_count)
    VALUES (actor, p_request_id, payload, p_list_id, added);
  RETURN jsonb_build_object('list', public.finder_selected_list_metadata(p_list_id), 'added_count', added);
END $$;

REVOKE ALL ON FUNCTION public.finder_create_selected_list(uuid, text, text[], uuid),
  public.finder_append_selected_people(uuid, uuid, text[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finder_create_selected_list(uuid, text, text[], uuid),
  public.finder_append_selected_people(uuid, uuid, text[], uuid) TO authenticated;
COMMIT;