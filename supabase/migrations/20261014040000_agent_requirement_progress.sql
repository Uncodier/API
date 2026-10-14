-- Optional agent-owned plans. No acceptance/Judge/retry/product gates.
-- Rollback: DROP FUNCTION public.patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint);
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE FUNCTION public.patch_agent_requirement_plan(
  p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid,
  p_plan_id uuid,p_title text,p_steps jsonb,p_expected_backlog_revision bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r public.requirements%ROWTYPE; p public.instance_plans%ROWTYPE; i uuid;
  entry jsonb; current_step jsonb; updated_steps jsonb; sid text; item_id text;
  n integer; revision bigint; created boolean:=false;
BEGIN
  IF p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 300
    OR jsonb_typeof(p_steps) IS DISTINCT FROM 'array' OR jsonb_array_length(p_steps)>40
    OR octet_length(p_steps::text)>200000 OR p_expected_backlog_revision IS NULL OR p_expected_backlog_revision<0
  THEN RAISE EXCEPTION 'Invalid requirement plan patch' USING ERRCODE='22023'; END IF;
  IF NOT public.assert_agent_requirement_run(p_requirement_id,p_run_id,p_generation,p_session_id) THEN
    RETURN jsonb_build_object('state','stale'); END IF;
  SELECT * INTO r FROM public.requirements WHERE id=p_requirement_id FOR UPDATE;
  revision:=coalesce(r.backlog_revision,0);
  IF revision<>p_expected_backlog_revision THEN
    RETURN jsonb_build_object('state','revision_conflict','backlog_revision',revision); END IF;
  SELECT id INTO i FROM public.remote_instances
    WHERE id::text=r.metadata->>'runner_instance_id' AND site_id=r.site_id FOR UPDATE;
  IF i IS NULL THEN RETURN jsonb_build_object('state','stale'); END IF;
  -- Serialize per runner and respect the existing single-active-plan index. A
  -- seed request never replaces, cancels, or resumes another active/paused plan.
  IF p_plan_id IS NULL THEN
    SELECT * INTO p FROM public.instance_plans WHERE instance_id=i
      AND status IN ('pending','in_progress','active','paused') ORDER BY id LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      IF p.site_id<>r.site_id OR p.status='paused' OR p.metadata->>'requirement_id' IS DISTINCT FROM r.id::text
        OR coalesce(p.metadata->>'workflow_template','false')='true'
      THEN RETURN jsonb_build_object('state','stale'); END IF;
    ELSE
      p.id:=gen_random_uuid(); p.steps:='[]'::jsonb; created:=true;
    END IF;
  ELSE
    SELECT * INTO p FROM public.instance_plans WHERE id=p_plan_id AND site_id=r.site_id AND instance_id=i FOR UPDATE;
    IF NOT FOUND OR p.status='paused' OR coalesce(p.metadata->>'workflow_template','false')='true'
      OR (p.metadata->>'requirement_id' IS NOT NULL AND p.metadata->>'requirement_id'<>r.id::text)
    THEN RETURN jsonb_build_object('state','stale'); END IF;
    -- Instance-only legacy plans are accepted only when every existing step
    -- links unambiguously to this backlog; never rewrite another task's plan.
    IF p.metadata->>'requirement_id' IS NULL AND (
      jsonb_typeof(p.steps) IS DISTINCT FROM 'array' OR jsonb_array_length(p.steps)=0
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p.steps) s WHERE
        NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.backlog->'items')='array' THEN r.backlog->'items' ELSE '[]' END) b
          WHERE b->>'id'=coalesce(s#>>'{metadata,backlog_item_id}',s->>'backlog_item_id')))
    ) THEN RETURN jsonb_build_object('state','stale'); END IF;
  END IF;
  IF jsonb_typeof(p.steps) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('state','stale'); END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_steps) s WHERE s->>'id' IS NOT NULL GROUP BY s->>'id' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Duplicate plan step IDs' USING ERRCODE='22023'; END IF;
  updated_steps:=p.steps;
  FOR entry IN SELECT value FROM jsonb_array_elements(p_steps) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR jsonb_typeof(entry->'title') IS DISTINCT FROM 'string'
      OR length(btrim(entry->>'title')) NOT BETWEEN 1 AND 300
      OR (entry ? 'description' AND (jsonb_typeof(entry->'description') IS DISTINCT FROM 'string' OR length(entry->>'description')>4000))
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(entry) k WHERE k NOT IN ('id','title','description','metadata'))
      OR (entry ? 'metadata' AND (jsonb_typeof(entry->'metadata') IS DISTINCT FROM 'object'
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(entry->'metadata') k WHERE k<>'backlog_item_id')))
    THEN RAISE EXCEPTION 'Invalid plan step' USING ERRCODE='22023'; END IF;
    sid:=entry->>'id'; item_id:=entry#>>'{metadata,backlog_item_id}';
    IF (entry ? 'id' AND (jsonb_typeof(entry->'id') IS DISTINCT FROM 'string' OR sid !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'))
      OR (entry->'metadata' ? 'backlog_item_id' AND (jsonb_typeof(entry#>'{metadata,backlog_item_id}') IS DISTINCT FROM 'string'
        OR item_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'))
    THEN RAISE EXCEPTION 'Invalid plan step identifier' USING ERRCODE='22023'; END IF;
    IF item_id IS NOT NULL THEN
      SELECT count(*) INTO n FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.backlog->'items')='array' THEN r.backlog->'items' ELSE '[]' END) b WHERE b->>'id'=item_id;
      IF n<>1 THEN RETURN jsonb_build_object('state','not_found'); END IF;
    END IF;
    sid:=coalesce(sid,gen_random_uuid()::text);
    SELECT count(*) INTO n FROM jsonb_array_elements(updated_steps) s WHERE s->>'id'=sid;
    IF n>1 THEN RETURN jsonb_build_object('state','stale'); END IF;
    IF n=1 THEN
      SELECT value INTO current_step FROM jsonb_array_elements(updated_steps) WHERE value->>'id'=sid;
      IF coalesce(current_step#>>'{metadata,backlog_item_id}',current_step->>'backlog_item_id') IS NOT NULL THEN
        SELECT count(*) INTO n FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.backlog->'items')='array' THEN r.backlog->'items' ELSE '[]' END) b
          WHERE b->>'id'=coalesce(current_step#>>'{metadata,backlog_item_id}',current_step->>'backlog_item_id');
        IF n<>1 THEN RETURN jsonb_build_object('state','not_found'); END IF;
      END IF;
      -- Description updates cannot resume a manually paused step or silently
      -- relink it to another task. Preserve status, acceptance and legacy keys.
      IF current_step->>'status'='paused' OR (item_id IS NOT NULL AND
        coalesce(current_step#>>'{metadata,backlog_item_id}',current_step->>'backlog_item_id',item_id)<>item_id)
      THEN RETURN jsonb_build_object('state','stale'); END IF;
      current_step:=current_step||jsonb_build_object('title',entry->>'title');
      IF entry ? 'description' THEN current_step:=current_step||jsonb_build_object('description',entry->>'description'); END IF;
      IF item_id IS NOT NULL THEN current_step:=jsonb_set(current_step,'{metadata}',coalesce(current_step->'metadata','{}')||jsonb_build_object('backlog_item_id',item_id)); END IF;
      SELECT jsonb_agg(CASE WHEN value->>'id'=sid THEN current_step ELSE value END ORDER BY ord)
        INTO updated_steps FROM jsonb_array_elements(updated_steps) WITH ORDINALITY a(value,ord);
    ELSE
      updated_steps:=updated_steps||jsonb_build_array((entry-'metadata')||jsonb_build_object('id',sid,'status','pending')||
        CASE WHEN item_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('metadata',jsonb_build_object('backlog_item_id',item_id)) END);
    END IF;
  END LOOP;
  IF created THEN
    INSERT INTO public.instance_plans(id,instance_id,site_id,user_id,title,plan_type,status,steps,metadata,steps_total,steps_completed)
      VALUES(p.id,i,r.site_id,r.user_id,btrim(p_title),'task','pending',updated_steps,
        jsonb_build_object('requirement_id',r.id,'agent_run_id',p_run_id,'harness_session_id',p_session_id),jsonb_array_length(updated_steps),0);
  ELSE
    UPDATE public.instance_plans SET title=btrim(p_title),steps=updated_steps,steps_total=jsonb_array_length(updated_steps),updated_at=clock_timestamp()
      WHERE id=p.id;
  END IF;
  UPDATE public.requirements SET backlog_revision=revision+1 WHERE id=r.id RETURNING backlog_revision INTO revision;
  RETURN jsonb_build_object('state',CASE WHEN created THEN 'created' ELSE 'updated' END,'plan_id',p.id,'backlog_revision',revision);
EXCEPTION WHEN unique_violation THEN
  -- Whole function block rolls back; another writer may have seeded a plan.
  RETURN jsonb_build_object('state','revision_conflict');
END;
$$;
REVOKE ALL ON FUNCTION public.patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;