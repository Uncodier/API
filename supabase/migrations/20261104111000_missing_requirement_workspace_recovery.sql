BEGIN;
SET LOCAL lock_timeout = '5s';

-- Only the trusted host may invoke retirement, after a confirmed provider GET
-- 404 and before reprovisioning. SQL cannot verify that provider observation.
-- A private, transaction-local-in-effect permit lets the identity trigger admit
-- this exact transition without a forgeable GUC or relaxing generic saves.
CREATE TABLE public.harness_workspace_retirement_permits (
  session_id uuid PRIMARY KEY REFERENCES public.harness_sessions(id) ON DELETE CASCADE,
  expected_version bigint NOT NULL,
  resource text NOT NULL,
  transaction_id bigint NOT NULL
);
ALTER TABLE public.harness_workspace_retirement_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.harness_workspace_retirement_permits FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the existing identity, monotonicity and explicit-generation reopen
-- guards. The only exception is a one-use permit from the dedicated RPC below.
CREATE OR REPLACE FUNCTION public.guard_harness_session()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE explicit_reopen boolean:=false; workspace_retirement boolean:=false;
BEGIN
  IF NOT public.valid_harness_snapshot(NEW.snapshot) THEN RAISE EXCEPTION 'Invalid harness snapshot' USING ERRCODE='22023'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.snapshot->>'status'<>'queued' OR NEW.version<>0
      OR (NEW.snapshot->>'turns')::numeric<>0 OR (NEW.snapshot->>'allocatedTokens')::numeric<>0 OR (NEW.snapshot->>'activeMs')::numeric<>0
      OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial harness session' USING ERRCODE='22023'; END IF;
  ELSE
    IF OLD.snapshot ? 'workspace' AND NOT (NEW.snapshot ? 'workspace')
      AND OLD.snapshot->>'status'='running' AND NEW.version=OLD.version+1
      AND NEW.snapshot-ARRAY['version','updatedAt']=OLD.snapshot-ARRAY['workspace','version','updatedAt']
      AND to_jsonb(NEW)-ARRAY['snapshot','version']=to_jsonb(OLD)-ARRAY['snapshot','version']
      AND OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at>clock_timestamp()
      AND OLD.sandbox_cleanup_token IS NULL THEN
      DELETE FROM public.harness_workspace_retirement_permits
        WHERE session_id=OLD.id AND expected_version=OLD.version
          AND resource=OLD.snapshot#>>'{workspace,id}' AND transaction_id=txid_current();
      workspace_retirement:=FOUND;
    END IF;
    explicit_reopen:=OLD.snapshot->>'status'='completed' AND NEW.snapshot->>'status'='queued'
      AND (OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp())
      AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
      AND NEW.snapshot-ARRAY['status','version','updatedAt']=OLD.snapshot-ARRAY['status','version','updatedAt']
      AND EXISTS (SELECT 1 FROM public.harness_requirement_runs h JOIN public.requirements r ON r.id=h.requirement_id
        WHERE h.session_id=OLD.id AND h.site_id=OLD.site_id AND r.site_id=OLD.site_id AND r.user_id=OLD.user_id
          AND r.status IN ('backlog','in-progress','blocked') AND NOT coalesce(r.metadata ? 'execution_hold',false)
          AND CASE WHEN r.metadata->>'requirement_execution_generation' ~ '^[0-9]{1,9}$'
            THEN (r.metadata->>'requirement_execution_generation')::integer>h.generation ELSE false END);
    IF NEW.id<>OLD.id OR NEW.site_id<>OLD.site_id OR NEW.user_id<>OLD.user_id
      OR NEW.snapshot->'request' IS DISTINCT FROM OLD.snapshot->'request'
      OR NEW.snapshot->'createdAt' IS DISTINCT FROM OLD.snapshot->'createdAt'
      OR (OLD.snapshot ? 'workspace' AND NEW.snapshot->'workspace' IS DISTINCT FROM OLD.snapshot->'workspace' AND NOT workspace_retirement) THEN
      RAISE EXCEPTION 'Harness identity is immutable' USING ERRCODE='22023'; END IF;
    IF NEW.version<OLD.version OR NEW.version>OLD.version+1
      OR (NEW.snapshot IS DISTINCT FROM OLD.snapshot AND NEW.version<>OLD.version+1)
      OR (OLD.snapshot->>'status' IN ('completed','cancelled') AND NEW.snapshot IS DISTINCT FROM OLD.snapshot AND NOT explicit_reopen)
      OR (NEW.snapshot->>'turns')::numeric<(OLD.snapshot->>'turns')::numeric
      OR (NEW.snapshot->>'allocatedTokens')::numeric<(OLD.snapshot->>'allocatedTokens')::numeric
      OR (NEW.snapshot->>'activeMs')::numeric<(OLD.snapshot->>'activeMs')::numeric
      OR NOT ((NEW.snapshot->'uncertainOperations') @> (OLD.snapshot->'uncertainOperations')) THEN
      RAISE EXCEPTION 'Invalid harness snapshot update' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_harness_session() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.retire_missing_harness_workspace(
  p_id uuid, p_site_id uuid, p_owner text, p_expected_version bigint, p_resource text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.requirements%ROWTYPE; m public.harness_requirement_runs%ROWTYPE;
  s public.harness_sessions%ROWTYPE; requirement_id_text text; result jsonb; t timestamptz;
BEGIN
  IF p_owner IS NULL OR length(btrim(p_owner))=0 OR length(p_owner)>200
    OR p_expected_version IS NULL OR p_expected_version<0 OR p_expected_version>=9007199254740991
    OR p_resource IS NULL OR length(p_resource) NOT BETWEEN 1 AND 1000 THEN RETURN NULL; END IF;
  -- Discovery is not authorization. Lock requirement -> mapping -> session,
  -- matching assert_agent_requirement_run, and recheck every binding afterward.
  SELECT snapshot#>>'{request,requirementId}' INTO requirement_id_text
    FROM public.harness_sessions WHERE id=p_id AND site_id=p_site_id;
  IF requirement_id_text IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO r FROM public.requirements WHERE id::text=requirement_id_text AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO m FROM public.harness_requirement_runs WHERE requirement_id=r.id FOR UPDATE;
  IF NOT FOUND OR m.site_id IS DISTINCT FROM p_site_id OR m.session_id IS DISTINCT FROM p_id
    OR r.metadata->>'requirement_execution_generation' IS DISTINCT FROM m.generation::text THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.harness_sessions WHERE id=p_id AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  t:=clock_timestamp();
  IF s.user_id IS DISTINCT FROM r.user_id OR s.snapshot#>>'{request,requirementId}' IS DISTINCT FROM r.id::text
    OR s.version IS DISTINCT FROM p_expected_version OR s.lease_owner IS DISTINCT FROM p_owner
    OR s.lease_expires_at IS NULL OR s.lease_expires_at<=t
    OR s.snapshot->>'status' IS DISTINCT FROM 'running' OR s.sandbox_cleanup_token IS NOT NULL
    OR s.snapshot#>>'{workspace,id}' IS DISTINCT FROM p_resource
    OR r.cron_lock_active IS NOT TRUE OR nullif(btrim(r.cron_lock_run_id),'') IS NULL
    OR r.cron_lock_expires_at IS NULL OR r.cron_lock_expires_at<=t
    OR r.status IS NULL OR r.status NOT IN ('backlog','in-progress')
    OR r.metadata ? 'execution_hold'
    OR coalesce(r.metadata->>'customer_paused','false')='true'
    OR coalesce(r.metadata->>'user_paused','false')='true'
    OR coalesce(r.metadata->>'cron_paused','false')='true' THEN RETURN NULL; END IF;

  INSERT INTO public.harness_workspace_retirement_permits VALUES(p_id,p_expected_version,p_resource,txid_current());
  UPDATE public.harness_sessions SET version=version+1,
    snapshot=(snapshot-'workspace') || jsonb_build_object('version',version+1,'updatedAt',t)
    WHERE id=p_id AND site_id=p_site_id RETURNING snapshot INTO result;
  -- The identity trigger must have consumed the permit in this same statement.
  IF EXISTS (SELECT 1 FROM public.harness_workspace_retirement_permits WHERE session_id=p_id) THEN
    RAISE EXCEPTION 'Workspace retirement guard did not consume authorization';
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.retire_missing_harness_workspace(uuid,uuid,text,bigint,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retire_missing_harness_workspace(uuid,uuid,text,bigint,text) TO service_role;
COMMENT ON FUNCTION public.retire_missing_harness_workspace(uuid,uuid,text,bigint,text) IS
  'Trusted host only, after confirmed provider GET 404: CAS-retire the current requirement workspace reference before reprovisioning. Does not delete resources or renew/release leases.';
NOTIFY pgrst, 'reload schema';
COMMIT;