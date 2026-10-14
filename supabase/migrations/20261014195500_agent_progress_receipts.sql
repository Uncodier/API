-- Scoped progress receipts only: no completion gates or automatic plan closure.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.patch_agent_requirement_progress(p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid,
  p_plan_id uuid,p_step_id text,p_item_id text,p_status text,p_message text,p_expected_backlog_revision bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r public.requirements%ROWTYPE; p public.instance_plans%ROWTYPE; entries jsonb; n integer; revision bigint;
  step_status text; item_status text; current_step jsonb; current_item jsonb;
  status_changed boolean:=false; message_recorded boolean:=false;
  plan_steps_total bigint; plan_steps_completed bigint; backlog_items_total bigint; backlog_items_completed bigint;
BEGIN
  step_status:=CASE WHEN p_status='done' THEN 'completed' ELSE p_status END;
  item_status:=CASE WHEN p_status='completed' THEN 'done' ELSE p_status END;
  IF length(p_message)>20000 OR length(p_step_id)>200 OR length(p_item_id)>200
    OR (p_step_id IS NOT NULL AND p_plan_id IS NULL)
    OR (p_status IS NOT NULL AND p_status NOT IN ('pending','in_progress','completed','done','failed'))
    OR (p_status IS NOT NULL AND p_plan_id IS NULL AND p_item_id IS NULL)
    OR (p_status IS NULL AND nullif(p_message,'') IS NULL)
  THEN RAISE EXCEPTION 'Invalid agent progress patch' USING ERRCODE='22023'; END IF;
  -- Preserve the existing ownership/pause assertion and its lease renewal.
  IF NOT public.assert_agent_requirement_run(p_requirement_id,p_run_id,p_generation,p_session_id) THEN
    RETURN jsonb_build_object('state','stale'); END IF;
  SELECT * INTO r FROM public.requirements WHERE id=p_requirement_id FOR UPDATE;
  revision:=coalesce(r.backlog_revision,0);
  IF p_expected_backlog_revision IS NOT NULL AND p_expected_backlog_revision<>revision THEN
    RETURN jsonb_build_object('state','revision_conflict','backlog_revision',revision); END IF;
  IF p_plan_id IS NOT NULL THEN
    SELECT * INTO p FROM public.instance_plans WHERE id=p_plan_id AND site_id=r.site_id
      AND instance_id::text=r.metadata->>'runner_instance_id' FOR UPDATE;
    IF NOT FOUND OR p.status='paused' OR (p.metadata->>'requirement_id' IS NOT NULL AND p.metadata->>'requirement_id'<>r.id::text) THEN
      RETURN jsonb_build_object('state','stale'); END IF;
  END IF;
  -- Validate both status targets before writing either. Message-only calls keep
  -- the original permissive target semantics, with absent receipt targets null.
  IF p_step_id IS NOT NULL THEN
    SELECT count(*) INTO n FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p.steps)='array' THEN p.steps ELSE '[]'::jsonb END) e WHERE e->>'id'=p_step_id;
    IF n<>1 AND p_status IS NOT NULL THEN RETURN jsonb_build_object('state','not_found'); END IF;
    IF n=1 THEN SELECT e INTO current_step FROM jsonb_array_elements(p.steps) e WHERE e->>'id'=p_step_id; END IF;
  END IF;
  IF p_item_id IS NOT NULL THEN
    SELECT count(*) INTO n FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.backlog->'items')='array' THEN r.backlog->'items' ELSE '[]'::jsonb END) e WHERE e->>'id'=p_item_id;
    IF n<>1 AND p_status IS NOT NULL THEN RETURN jsonb_build_object('state','not_found'); END IF;
    IF n=1 THEN SELECT e INTO current_item FROM jsonb_array_elements(r.backlog->'items') e WHERE e->>'id'=p_item_id; END IF;
  END IF;
  -- Compare the canonical requested status under the row locks. No progress
  -- rewrite, timestamp change, or revision bump for an already-current status.
  IF p_plan_id IS NOT NULL AND p_step_id IS NULL AND p_status IS NOT NULL AND p.status IS DISTINCT FROM step_status THEN
    UPDATE public.instance_plans SET status=step_status,updated_at=clock_timestamp() WHERE id=p.id RETURNING * INTO p;
    status_changed:=true;
  END IF;
  IF p_step_id IS NOT NULL AND p_status IS NOT NULL AND current_step->>'status' IS DISTINCT FROM step_status THEN
    SELECT jsonb_agg(CASE WHEN e->>'id'=p_step_id THEN e||jsonb_build_object('status',step_status) ELSE e END ORDER BY ord)
      INTO entries FROM jsonb_array_elements(p.steps) WITH ORDINALITY a(e,ord);
    UPDATE public.instance_plans SET steps=entries,updated_at=clock_timestamp() WHERE id=p.id RETURNING * INTO p;
    current_step:=current_step||jsonb_build_object('status',step_status);
    status_changed:=true;
  END IF;
  IF p_item_id IS NOT NULL AND p_status IS NOT NULL AND current_item->>'status' IS DISTINCT FROM item_status THEN
    SELECT jsonb_agg(CASE WHEN e->>'id'=p_item_id THEN e||jsonb_build_object('status',item_status) ELSE e END ORDER BY ord)
      INTO entries FROM jsonb_array_elements(r.backlog->'items') WITH ORDINALITY a(e,ord);
    UPDATE public.requirements SET backlog=jsonb_set(backlog,'{items}',entries),backlog_revision=revision+1
      WHERE id=r.id RETURNING * INTO r;
    revision:=r.backlog_revision;
    current_item:=current_item||jsonb_build_object('status',item_status);
    status_changed:=true;
  END IF;
  IF nullif(p_message,'') IS NOT NULL THEN
    INSERT INTO public.requirement_status(requirement_id,site_id,instance_id,stage,message)
      VALUES(r.id,r.site_id,(r.metadata->>'runner_instance_id')::uuid,'in-progress',p_message);
    message_recorded:=true;
  END IF;
  -- Full-array counts, not cached columns or a bounded context preview. Neither
  -- these counts nor completing the last step changes the plan status.
  SELECT count(*),count(*) FILTER (WHERE e->>'status' IN ('done','completed')) INTO plan_steps_total,plan_steps_completed
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.steps)='array' THEN p.steps ELSE '[]'::jsonb END) e;
  SELECT count(*),count(*) FILTER (WHERE e->>'status' IN ('done','completed')) INTO backlog_items_total,backlog_items_completed
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.backlog->'items')='array' THEN r.backlog->'items' ELSE '[]'::jsonb END) e;
  RETURN jsonb_build_object(
    'state',CASE WHEN status_changed THEN 'updated' ELSE 'unchanged' END,
    'status_changed',status_changed,'message_recorded',message_recorded,'backlog_revision',revision,
    'plan_id',p.id,'plan_status',p.status,'step_id',current_step->>'id','step_status',current_step->>'status',
    'item_id',current_item->>'id','item_status',current_item->>'status',
    'plan_steps_total',plan_steps_total,'plan_steps_completed',plan_steps_completed,
    'backlog_items_total',backlog_items_total,'backlog_items_completed',backlog_items_completed);
END;
$$;
REVOKE ALL ON FUNCTION public.patch_agent_requirement_progress(uuid,text,integer,uuid,uuid,text,text,text,text,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.patch_agent_requirement_progress(uuid,text,integer,uuid,uuid,text,text,text,text,bigint) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;