-- Private host receipt; no source text or credentials. No automatic run/status changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE public.requirement_source_checkpoints (
  requirement_id uuid PRIMARY KEY REFERENCES public.requirements(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id),
  session_id uuid NOT NULL,
  baseline jsonb,
  pending_publication jsonb,
  last_result jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.requirement_source_checkpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.requirement_source_checkpoints FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.requirement_source_checkpoints TO service_role;

-- Write-ahead publication identity: stored BEFORE updating the GitHub branch.
-- A lost final receipt must leave enough trusted data for a later owner to reconcile.
CREATE FUNCTION public.prepare_requirement_source_checkpoint(
  p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid,
  p_owner text,p_intent jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; s public.harness_sessions%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_intent) IS DISTINCT FROM 'object' OR octet_length(p_intent::text)>4000000
    OR coalesce(p_intent->>'parentSha','') !~ '^[0-9a-f]{40}$'
    OR coalesce(p_intent->>'expectedSha','') !~ '^[0-9a-f]{40}$'
    OR jsonb_typeof(p_intent->'createRef') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_intent->'baseline') IS DISTINCT FROM 'object'
    OR p_intent#>>'{baseline,commitSha}' IS DISTINCT FROM p_intent->>'expectedSha'
  THEN RAISE EXCEPTION 'Invalid checkpoint publication intent' USING ERRCODE='22023'; END IF;
  IF NOT public.assert_agent_requirement_run(p_requirement_id,p_run_id,p_generation,p_session_id,false,300) THEN RETURN false; END IF;
  SELECT * INTO r FROM public.requirements WHERE id=p_requirement_id FOR UPDATE;
  SELECT * INTO s FROM public.harness_sessions WHERE id=p_session_id AND site_id=r.site_id FOR UPDATE;
  IF NOT FOUND OR p_owner IS NULL OR s.lease_owner IS DISTINCT FROM p_owner
    OR s.lease_expires_at IS NULL OR s.lease_expires_at<=clock_timestamp()
    OR s.snapshot->>'status' IS DISTINCT FROM 'running' THEN RETURN false; END IF;
  INSERT INTO public.requirement_source_checkpoints(requirement_id,site_id,session_id,pending_publication,last_result)
    VALUES(r.id,r.site_id,p_session_id,p_intent,'{"state":"unknown","reason":"publication_prepared"}'::jsonb)
    ON CONFLICT(requirement_id) DO UPDATE SET session_id=EXCLUDED.session_id,
      pending_publication=EXCLUDED.pending_publication,updated_at=clock_timestamp();
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.prepare_requirement_source_checkpoint(uuid,text,integer,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.prepare_requirement_source_checkpoint(uuid,text,integer,uuid,text,jsonb) TO service_role;

CREATE FUNCTION public.record_requirement_source_checkpoint(
  p_requirement_id uuid,p_run_id text,p_generation integer,p_session_id uuid,
  p_owner text,p_result jsonb,p_baseline jsonb DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; s public.harness_sessions%ROWTYPE; state text; message text;
BEGIN
  state:=p_result->>'state';
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR state IS NULL
    OR state NOT IN ('saved','unchanged','skipped','failed','unknown')
    OR octet_length(p_result::text)>8000
    OR (p_baseline IS NOT NULL AND (jsonb_typeof(p_baseline) IS DISTINCT FROM 'object'
      OR octet_length(p_baseline::text)>4000000 OR state NOT IN ('saved','unchanged')))
    OR (state IN ('saved','unchanged') AND (p_baseline IS NULL
      OR coalesce(p_result->>'sha','') !~ '^[0-9a-f]{40}$'
      OR p_baseline->>'commitSha' IS DISTINCT FROM p_result->>'sha'))
  THEN RAISE EXCEPTION 'Invalid source checkpoint receipt' USING ERRCODE='22023'; END IF;
  IF NOT public.assert_agent_requirement_run(p_requirement_id,p_run_id,p_generation,p_session_id,false,300) THEN RETURN false; END IF;
  SELECT * INTO r FROM public.requirements WHERE id=p_requirement_id FOR UPDATE;
  SELECT * INTO s FROM public.harness_sessions WHERE id=p_session_id AND site_id=r.site_id FOR UPDATE;
  IF NOT FOUND OR p_owner IS NULL OR s.lease_owner IS DISTINCT FROM p_owner
    OR s.lease_expires_at IS NULL OR s.lease_expires_at<=clock_timestamp()
    OR s.snapshot->>'status' IS DISTINCT FROM 'running' THEN RETURN false; END IF;
  INSERT INTO public.requirement_source_checkpoints(requirement_id,site_id,session_id,baseline,last_result)
    VALUES(r.id,r.site_id,p_session_id,p_baseline,p_result)
    ON CONFLICT(requirement_id) DO UPDATE SET session_id=EXCLUDED.session_id,
      baseline=coalesce(EXCLUDED.baseline,public.requirement_source_checkpoints.baseline),
      pending_publication=CASE WHEN state IN ('saved','unchanged') THEN NULL
        ELSE public.requirement_source_checkpoints.pending_publication END,
      last_result=EXCLUDED.last_result,updated_at=clock_timestamp();
  message:=CASE WHEN state IN ('saved','unchanged') THEN
    'Source checkpoint confirmed on GitHub: '||(p_result->>'sha')||'. Excluded files: '||coalesce(p_result->>'excludedCount','0')||'. This is a bounded source backup, not a complete sandbox backup, deployment or task acceptance.'
    ELSE 'Source checkpoint not confirmed ('||state||'). Sandbox work was not reset; retry on a later owned cycle.' END;
  INSERT INTO public.requirement_status(requirement_id,site_id,instance_id,stage,cycle,message,repo_url)
    VALUES(r.id,r.site_id,(r.metadata->>'runner_instance_id')::uuid,r.status,
      'source-checkpoint:'||p_run_id,message,
      CASE WHEN state IN ('saved','unchanged') THEN p_result->>'repoUrl' ELSE NULL END);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.record_requirement_source_checkpoint(uuid,text,integer,uuid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_requirement_source_checkpoint(uuid,text,integer,uuid,text,jsonb,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;