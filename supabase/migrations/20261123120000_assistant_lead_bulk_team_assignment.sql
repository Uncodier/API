-- Extend the existing RPC without changing its signature, grants or stored receipts.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.assistant_lead_bulk_previews
  DROP CONSTRAINT assistant_lead_bulk_previews_operation_check,
  ADD CONSTRAINT assistant_lead_bulk_previews_operation_check
    CHECK (operation IN ('create','assign_to_me','assign_to_member','change_status','delete'));

CREATE OR REPLACE FUNCTION public.assistant_leads_bulk(
  p_site_id uuid, p_user_id uuid, p_instance_id uuid, p_action_id uuid,
  p_operation text, p_payload jsonb, p_preview_id uuid, p_expected_count integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET timezone = 'UTC' SET lock_timeout = '5s' AS $$
DECLARE
  v_site public.sites%ROWTYPE;
  v_member public.site_members%ROWTYPE;
  v_action public.instance_logs%ROWTYPE;
  v_preview public.assistant_lead_bulk_previews%ROWTYPE;
  v_owner boolean;
  v_admin boolean;
  v_assigned boolean;
  v_hash bytea;
  v_ids uuid[] := '{}';
  v_found uuid[] := '{}';
  v_missing uuid[] := '{}';
  v_affected uuid[];
  v_rows jsonb := '[]'::jsonb;
  v_revisions jsonb := '[]'::jsonb;
  v_selection jsonb;
  v_count integer;
  v_replayed boolean := false;
  v_assignee_id uuid;
  v_status text := p_payload->>'status';
  v_statuses constant text[] := ARRAY['new','contacted','qualified','converted','lost','cold','not_qualified'];
  v_denied constant jsonb := '{"success":false,"code":"access_denied"}';
  v_invalid constant jsonb := '{"success":false,"code":"invalid_preview"}';
  v_changed constant jsonb := '{"success":false,"code":"selection_changed"}';
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('create','assign_to_me','assign_to_member','change_status','delete')
     OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid lead batch' USING ERRCODE = '22023';
  END IF;

  -- Recheck the live site, actor, conversation and authenticated action in the
  -- same transaction as the write. Locks serialize role/restriction updates
  -- to existing memberships, ownership, archival and cancellation.
  SELECT * INTO v_site FROM public.sites WHERE id = p_site_id AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND OR p_user_id IS NULL THEN RETURN v_denied; END IF;
  PERFORM 1 FROM public.remote_instances WHERE id = p_instance_id AND site_id = p_site_id
    AND is_archived IS NOT TRUE FOR SHARE;
  IF NOT FOUND THEN RETURN v_denied; END IF;
  SELECT * INTO v_action FROM public.instance_logs
    WHERE id = p_action_id AND instance_id = p_instance_id AND site_id = p_site_id AND user_id = p_user_id
      AND log_type = 'user_action' AND trusted_user_action IS TRUE AND details->>'status' = 'running'
      AND details->'lead_bulk_user_session' = 'true'::jsonb FOR SHARE;
  IF NOT FOUND THEN RETURN v_denied; END IF;

  IF p_operation = 'assign_to_member' THEN
    IF jsonb_typeof(p_payload->'assignee_id') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid lead assignee' USING ERRCODE = '22023';
    END IF;
    v_assignee_id := (p_payload->>'assignee_id')::uuid;
    p_payload := jsonb_set(p_payload, '{assignee_id}', to_jsonb(v_assignee_id));
  ELSIF p_payload ? 'assignee_id' THEN
    RAISE EXCEPTION 'Invalid lead assignee' USING ERRCODE = '22023';
  END IF;

  -- Lock actor and assignee memberships together in a stable order so two
  -- concurrent assignments in opposite directions do not invert their locks.
  PERFORM 1 FROM public.site_members WHERE user_id = p_user_id
    OR (user_id = v_assignee_id AND site_id = p_site_id) ORDER BY id FOR UPDATE;
  IF public.site_user_has_effective_access(p_site_id, p_user_id) IS NOT TRUE THEN RETURN v_denied; END IF;
  PERFORM 1 FROM public.site_ownership WHERE site_id = p_site_id AND user_id = p_user_id FOR SHARE;
  v_owner := v_site.user_id IS NOT DISTINCT FROM p_user_id OR FOUND;
  SELECT * INTO v_member FROM public.site_members
    WHERE site_id = p_site_id AND user_id = p_user_id AND status = 'active';
  v_admin := v_owner OR coalesce(v_member.role IN ('owner','admin'), false);
  v_assigned := NOT v_owner AND v_member.restrict_to_assigned_only IS DISTINCT FROM false;
  IF (NOT v_admin AND (v_member.role IS DISTINCT FROM 'collaborator' OR 'leads' = ANY(coalesce(v_member.blocked_screens, '{}'))))
     OR (p_operation = 'delete' AND NOT v_admin)
     OR EXISTS (
       SELECT 1 FROM public.site_members m JOIN public.site_member_location_restrictions r
         ON r.site_id = m.site_id AND r.site_member_id = m.id
       JOIN public.sites s ON s.id = m.site_id
       WHERE m.user_id = p_user_id AND (
         public.site_user_has_effective_access(s.id, p_user_id) IS TRUE AND (
           s.user_id = p_user_id OR EXISTS (SELECT 1 FROM public.site_ownership o WHERE o.site_id = s.id AND o.user_id = p_user_id)
           OR (m.status = 'active' AND m.role IN ('owner','admin') AND public.site_member_has_effective_license(m.id) IS TRUE))) IS NOT TRUE) THEN
    RETURN v_denied;
  END IF;

  IF p_operation = 'create' THEN
    v_selection := p_payload->'leads';
  ELSE
    v_selection := p_payload->'lead_ids';
  END IF;
  IF jsonb_typeof(v_selection) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid lead selection' USING ERRCODE = '22023';
  END IF;
  v_count := jsonb_array_length(v_selection);
  IF v_count NOT BETWEEN 1 AND 50 OR (p_operation = 'change_status' AND (v_status IS NULL OR NOT v_status = ANY(v_statuses))) THEN
    RAISE EXCEPTION 'Invalid lead selection' USING ERRCODE = '22023';
  END IF;
  IF p_operation <> 'create' THEN
    SELECT array_agg(value::uuid ORDER BY value::uuid) INTO v_ids FROM jsonb_array_elements_text(v_selection);
    IF (SELECT count(DISTINCT id) FROM unnest(v_ids) AS ids(id)) <> v_count THEN
      RAISE EXCEPTION 'Invalid lead selection' USING ERRCODE = '22023';
    END IF;
    -- Treat ID order as immaterial; all other batch fields must match exactly.
    p_payload := jsonb_set(p_payload, '{lead_ids}', to_jsonb(v_ids));
  END IF;
  v_hash := sha256(convert_to(p_payload::text, 'UTF8'));

  IF p_preview_id IS NOT NULL THEN
    SELECT * INTO v_preview FROM public.assistant_lead_bulk_previews
      WHERE id = p_preview_id AND site_id = p_site_id AND user_id = p_user_id AND instance_id = p_instance_id FOR UPDATE;
    IF NOT FOUND OR v_preview.operation <> p_operation OR v_preview.request_hash <> v_hash
       OR p_expected_count IS DISTINCT FROM v_preview.matched_count OR v_count <> v_preview.matched_count THEN
      RETURN v_invalid;
    END IF;
    IF v_preview.affected_lead_ids IS NOT NULL THEN
      -- Replay reads the durable receipt; it must not recheck the pre-write row image.
      v_replayed := true;
      v_affected := v_preview.affected_lead_ids;
    ELSIF v_preview.created_at + interval '30 minutes' <= clock_timestamp() THEN
      RETURN v_invalid;
    ELSIF p_operation = 'delete' AND (v_action.id = v_preview.action_id OR v_action.created_at < v_preview.created_at
      OR btrim(v_action.message, E' \n\r\t') <> 'CONFIRM DELETE LEADS ' || v_preview.id::text) THEN
      RETURN '{"success":false,"code":"confirmation_required"}';
    END IF;
  END IF;

  IF NOT v_replayed AND p_operation = 'assign_to_member' THEN
    PERFORM 1 FROM public.site_ownership WHERE site_id = p_site_id AND user_id = v_assignee_id FOR SHARE;
    IF public.site_user_has_effective_access(p_site_id, v_assignee_id) IS NOT TRUE THEN
      RETURN '{"success":false,"code":"invalid_assignee"}';
    END IF;
  END IF;

  IF NOT v_replayed AND p_operation <> 'create' THEN
    -- Lock and compare both the database tuple version and the row image. This
    -- detects edits even from callers that leave updated_at unchanged.
    SELECT coalesce(array_agg(l.id ORDER BY l.id), '{}'),
           coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'status', l.status) ORDER BY l.id), '[]'),
           coalesce(jsonb_agg(jsonb_build_array(l.id, encode(sha256(convert_to(to_jsonb(l)::text, 'UTF8')), 'hex')) ORDER BY l.id), '[]')
      INTO v_found, v_rows, v_revisions FROM (
        SELECT l.*, l.xmin::text AS row_version FROM public.leads l WHERE l.site_id = p_site_id AND l.id = ANY(v_ids)
          AND (NOT v_assigned OR l.user_id = p_user_id OR l.assignee_id = p_user_id)
        ORDER BY l.id FOR UPDATE
      ) l;
    v_missing := ARRAY(SELECT id FROM unnest(v_ids) AS ids(id) WHERE NOT id = ANY(v_found));
    IF p_preview_id IS NOT NULL AND (cardinality(v_missing) <> 0 OR v_revisions <> v_preview.revisions) THEN
      RETURN v_changed;
    END IF;
  END IF;

  IF p_preview_id IS NULL THEN
    IF p_operation = 'create' THEN
      SELECT jsonb_agg(jsonb_build_object('name', draft->>'name', 'status', draft->>'status') ORDER BY n)
        INTO v_rows FROM jsonb_array_elements(v_selection) WITH ORDINALITY AS rows(draft, n);
      -- Later calls in the same user turn cannot mint another receipt for the
      -- same create payload, even if the first RPC response was lost.
      INSERT INTO public.assistant_lead_bulk_previews (site_id,user_id,instance_id,action_id,operation,request_hash,matched_count,revisions)
        VALUES (p_site_id,p_user_id,p_instance_id,p_action_id,p_operation,v_hash,v_count,v_revisions)
        ON CONFLICT (site_id,user_id,instance_id,action_id,request_hash) WHERE operation = 'create' DO NOTHING
        RETURNING * INTO v_preview;
      IF NOT FOUND THEN
        SELECT * INTO STRICT v_preview FROM public.assistant_lead_bulk_previews WHERE site_id = p_site_id
          AND user_id = p_user_id AND instance_id = p_instance_id AND action_id = p_action_id
          AND request_hash = v_hash AND operation = 'create';
      END IF;
    ELSIF cardinality(v_missing) = 0 THEN
      INSERT INTO public.assistant_lead_bulk_previews (site_id,user_id,instance_id,action_id,operation,request_hash,matched_count,revisions)
        VALUES (p_site_id,p_user_id,p_instance_id,p_action_id,p_operation,v_hash,v_count,v_revisions) RETURNING * INTO v_preview;
    END IF;
    RETURN jsonb_build_object('success',true,'action',p_operation,'dry_run',true,'requested_count',v_count,
      'matched_count',v_count - cardinality(v_missing),'missing_lead_ids',v_missing,'affected_count',0,
      CASE WHEN p_operation = 'create' THEN 'drafts' ELSE 'leads' END,v_rows)
      || CASE WHEN v_preview.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('preview_id',v_preview.id,
        'expires_at',v_preview.created_at + interval '30 minutes') END
      || CASE WHEN p_operation = 'delete' AND v_preview.id IS NOT NULL THEN
        jsonb_build_object('confirmation_message','CONFIRM DELETE LEADS ' || v_preview.id::text) ELSE '{}'::jsonb END
      || CASE WHEN p_operation = 'assign_to_member' THEN jsonb_build_object('assignee_id',v_assignee_id) ELSE '{}'::jsonb END;
  END IF;

  IF NOT v_replayed THEN
    IF p_operation = 'create' THEN
      WITH changed AS (
        INSERT INTO public.leads (site_id, user_id, name, email, phone, company, "position", notes, origin, status)
        SELECT p_site_id, p_user_id, d.name, d.email, d.phone,
          CASE WHEN d.company IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('name', d.company) END,
          d."position", d.notes, d.origin, d.status
        FROM jsonb_to_recordset(v_selection) AS d(name text,email text,phone text,company text,"position" text,notes text,origin text,status text)
        RETURNING id
      ) SELECT array_agg(id ORDER BY id) INTO v_affected FROM changed;
    ELSIF p_operation = 'delete' THEN
      WITH changed AS (DELETE FROM public.leads WHERE site_id = p_site_id AND id = ANY(v_found) RETURNING id)
        SELECT array_agg(id ORDER BY id) INTO v_affected FROM changed;
    ELSE
      WITH changed AS (
        UPDATE public.leads SET status = CASE WHEN p_operation = 'change_status' THEN v_status ELSE status END,
          assignee_id = CASE p_operation WHEN 'assign_to_me' THEN p_user_id
            WHEN 'assign_to_member' THEN v_assignee_id ELSE assignee_id END, updated_at = clock_timestamp()
        WHERE site_id = p_site_id AND id = ANY(v_found) RETURNING id
      ) SELECT array_agg(id ORDER BY id) INTO v_affected FROM changed;
    END IF;
    IF cardinality(v_affected) IS DISTINCT FROM v_count THEN
      RAISE EXCEPTION 'Incomplete lead write' USING ERRCODE = '23514';
    END IF;
    UPDATE public.assistant_lead_bulk_previews SET affected_lead_ids = v_affected WHERE id = p_preview_id;
  END IF;
  RETURN jsonb_build_object('success',true,'action',p_operation,'dry_run',false,'preview_id',p_preview_id,
    'affected_count',cardinality(v_affected),'affected_lead_ids',v_affected,'replayed',v_replayed)
    || CASE WHEN p_operation = 'assign_to_member' THEN jsonb_build_object('assignee_id',v_assignee_id) ELSE '{}'::jsonb END;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
