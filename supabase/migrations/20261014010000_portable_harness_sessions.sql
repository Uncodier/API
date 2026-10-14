-- Review-only migration for the portable harness. No requirement/plan state.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.valid_harness_snapshot(s jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE k text; n numeric; item jsonb;
BEGIN
  IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR octet_length(s::text) > 4000000 THEN RETURN false; END IF;
  IF jsonb_typeof(s->'id') IS DISTINCT FROM 'string'
    OR NOT (s->>'status' = ANY(ARRAY['queued','running','completed','waiting','paused','failed','cancelled']))
    OR jsonb_typeof(s->'status') IS DISTINCT FROM 'string'
    OR jsonb_typeof(s->'request') IS DISTINCT FROM 'object'
    OR jsonb_typeof(s#>'{request,limits}') IS DISTINCT FROM 'object'
    OR jsonb_typeof(s#>'{request,objective}') IS DISTINCT FROM 'string'
    OR length(s#>>'{request,objective}') NOT BETWEEN 1 AND 24000
    OR jsonb_typeof(s#>'{request,repository,url}') IS DISTINCT FROM 'string'
    OR length(s#>>'{request,repository,url}') NOT BETWEEN 1 AND 4000
    OR jsonb_typeof(s->'createdAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(s->'updatedAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(s->'messages') IS DISTINCT FROM 'array'
    OR jsonb_typeof(s->'uncertainOperations') IS DISTINCT FROM 'array'
  THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['version','turns','allocatedTokens','activeMs'] LOOP
    IF jsonb_typeof(s->k) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    n := (s->>k)::numeric;
    IF n < 0 OR n > 9007199254740991 OR trunc(n) <> n THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['maxTurns','maxOutputTokens','maxTotalTokens','maxActiveMs'] LOOP
    IF jsonb_typeof(s#>ARRAY['request','limits',k]) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    n := (s#>>ARRAY['request','limits',k])::numeric;
    IF n < 1 OR trunc(n) <> n OR n > (CASE k WHEN 'maxTurns' THEN 1000 WHEN 'maxOutputTokens' THEN 131072 WHEN 'maxTotalTokens' THEN 100000000 ELSE 86400000 END)
    THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_array_length(s->'messages') > 10000 OR jsonb_array_length(s->'uncertainOperations') > 10000 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(s->'messages') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'role') IS DISTINCT FROM 'string'
      OR NOT (item->>'role' = ANY(ARRAY['user','assistant','tool']))
      OR jsonb_typeof(item->'content') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(s->'uncertainOperations') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR length(item#>>'{}') > 1000 THEN RETURN false; END IF;
  END LOOP;
  IF s ? 'workspace' AND (jsonb_typeof(s->'workspace') IS DISTINCT FROM 'object'
    OR s#>>'{workspace,provider}' IS DISTINCT FROM 'vercel'
    OR jsonb_typeof(s#>'{workspace,id}') IS DISTINCT FROM 'string' OR length(s#>>'{workspace,id}') NOT BETWEEN 1 AND 1000
    OR jsonb_typeof(s#>'{workspace,root}') IS DISTINCT FROM 'string' OR left(s#>>'{workspace,root}',1) <> '/') THEN RETURN false; END IF;
  IF s ? 'pending' AND (jsonb_typeof(s->'pending') IS DISTINCT FROM 'object'
    OR jsonb_typeof(s#>'{pending,call}') IS DISTINCT FROM 'object'
    OR jsonb_typeof(s#>'{pending,call,id}') IS DISTINCT FROM 'string'
    OR jsonb_typeof(s#>'{pending,call,name}') IS DISTINCT FROM 'string'
    OR jsonb_typeof(s#>'{pending,call,arguments}') IS DISTINCT FROM 'string'
    OR jsonb_typeof(s#>'{pending,fingerprint}') IS DISTINCT FROM 'string'
    OR NOT (s#>>'{pending,effect}' = ANY(ARRAY['read','write']))
    OR jsonb_typeof(s#>'{pending,effect}') IS DISTINCT FROM 'string') THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE TABLE public.harness_sessions (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES public.sites(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  snapshot jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  lease_owner text,
  lease_expires_at timestamptz,
  CONSTRAINT harness_snapshot_valid CHECK (public.valid_harness_snapshot(snapshot)),
  CONSTRAINT harness_snapshot_identity CHECK (snapshot->>'id' = id::text AND (snapshot->>'version')::numeric = version),
  CONSTRAINT harness_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT harness_owner_bound CHECK (lease_owner IS NULL OR (length(btrim(lease_owner)) > 0 AND length(lease_owner) <= 200))
);
CREATE INDEX harness_sessions_site_idx ON public.harness_sessions(site_id, id);
ALTER TABLE public.harness_sessions ENABLE ROW LEVEL SECURITY;
-- No end-user policies; tenant/user authorization happens in the host API.
-- Remove permissive Supabase default privileges before selectively granting.
REVOKE ALL ON public.harness_sessions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.harness_sessions TO service_role;

-- Optional host profiles can bind shared infrastructure. Do not run two sessions
-- against the same profile while either still owns resumable work.
CREATE UNIQUE INDEX harness_sessions_active_profile ON public.harness_sessions
  (site_id, (snapshot#>>'{request,profile}'))
  WHERE snapshot#>>'{request,profile}' IS NOT NULL
    AND snapshot->>'status' NOT IN ('completed', 'cancelled');

CREATE FUNCTION public.guard_harness_session()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT public.valid_harness_snapshot(NEW.snapshot) THEN RAISE EXCEPTION 'Invalid harness snapshot' USING ERRCODE='22023'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.snapshot->>'status' <> 'queued' OR NEW.version <> 0
      OR (NEW.snapshot->>'turns')::numeric <> 0 OR (NEW.snapshot->>'allocatedTokens')::numeric <> 0 OR (NEW.snapshot->>'activeMs')::numeric <> 0
      OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
    THEN RAISE EXCEPTION 'Invalid initial harness session' USING ERRCODE='22023'; END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.site_id <> OLD.site_id OR NEW.user_id <> OLD.user_id
      OR NEW.snapshot->'request' IS DISTINCT FROM OLD.snapshot->'request'
      OR NEW.snapshot->'createdAt' IS DISTINCT FROM OLD.snapshot->'createdAt'
      OR (OLD.snapshot ? 'workspace' AND NEW.snapshot->'workspace' IS DISTINCT FROM OLD.snapshot->'workspace')
    THEN RAISE EXCEPTION 'Harness identity is immutable' USING ERRCODE='22023'; END IF;
    IF NEW.version < OLD.version OR NEW.version > OLD.version + 1
      OR (NEW.snapshot IS DISTINCT FROM OLD.snapshot AND NEW.version <> OLD.version + 1)
      OR (OLD.snapshot->>'status' IN ('completed','cancelled') AND NEW.snapshot IS DISTINCT FROM OLD.snapshot)
      OR (NEW.snapshot->>'turns')::numeric < (OLD.snapshot->>'turns')::numeric
      OR (NEW.snapshot->>'allocatedTokens')::numeric < (OLD.snapshot->>'allocatedTokens')::numeric
      OR (NEW.snapshot->>'activeMs')::numeric < (OLD.snapshot->>'activeMs')::numeric
      OR NOT ((NEW.snapshot->'uncertainOperations') @> (OLD.snapshot->'uncertainOperations'))
    THEN RAISE EXCEPTION 'Invalid harness snapshot update' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER harness_session_guard BEFORE INSERT OR UPDATE ON public.harness_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_harness_session();

CREATE FUNCTION public.claim_harness_session(p_id uuid, p_site_id uuid, p_owner text, p_ttl_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.harness_sessions%ROWTYPE; result jsonb; t timestamptz;
BEGIN
  IF p_owner IS NULL OR length(btrim(p_owner)) = 0 OR length(p_owner) > 200 OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 300
  THEN RAISE EXCEPTION 'Invalid harness lease' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM public.harness_sessions WHERE id=p_id AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  t := clock_timestamp();
  IF r.snapshot->>'status' NOT IN ('queued','running')
    OR (r.lease_owner IS NOT NULL AND r.lease_owner <> p_owner AND r.lease_expires_at > t) THEN RETURN NULL; END IF;
  UPDATE public.harness_sessions SET
    lease_owner=p_owner, lease_expires_at=t+make_interval(secs=>p_ttl_seconds), version=version+1,
    snapshot=snapshot || jsonb_build_object('status','running','version',version+1,'updatedAt',t)
    WHERE id=p_id AND site_id=p_site_id RETURNING snapshot INTO result;
  RETURN result;
END;
$$;

CREATE FUNCTION public.save_harness_session(p_id uuid, p_site_id uuid, p_owner text, p_snapshot jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.harness_sessions%ROWTYPE; result jsonb; t timestamptz;
BEGIN
  IF NOT public.valid_harness_snapshot(p_snapshot) OR p_snapshot->>'id' IS DISTINCT FROM p_id::text OR p_snapshot->>'status' = 'queued'
  THEN RAISE EXCEPTION 'Invalid harness snapshot' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM public.harness_sessions WHERE id=p_id AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  t := clock_timestamp();
  IF r.lease_owner IS DISTINCT FROM p_owner OR p_owner IS NULL OR r.lease_expires_at IS NULL OR r.lease_expires_at <= t
    OR r.snapshot->>'status' <> 'running' OR r.version <> (p_snapshot->>'version')::bigint THEN RETURN NULL; END IF;
  UPDATE public.harness_sessions SET version=version+1,
    snapshot=p_snapshot || jsonb_build_object('version',version+1,'updatedAt',t)
    WHERE id=p_id AND site_id=p_site_id RETURNING snapshot INTO result;
  RETURN result;
END;
$$;

CREATE FUNCTION public.renew_harness_session(p_id uuid, p_site_id uuid, p_owner text, p_ttl_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.harness_sessions%ROWTYPE; t timestamptz;
BEGIN
  IF p_owner IS NULL OR length(btrim(p_owner)) = 0 OR length(p_owner) > 200 OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 300
  THEN RAISE EXCEPTION 'Invalid harness lease' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM public.harness_sessions WHERE id=p_id AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  t := clock_timestamp();
  IF r.lease_owner IS DISTINCT FROM p_owner OR r.lease_expires_at IS NULL OR r.lease_expires_at <= t OR r.snapshot->>'status' <> 'running' THEN RETURN false; END IF;
  UPDATE public.harness_sessions SET lease_expires_at=t+make_interval(secs=>p_ttl_seconds) WHERE id=p_id AND site_id=p_site_id;
  RETURN true;
END;
$$;

CREATE FUNCTION public.release_harness_session(p_id uuid, p_site_id uuid, p_owner text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- Release works after a terminal save, without replacing status or snapshot.
  UPDATE public.harness_sessions SET lease_owner=NULL, lease_expires_at=NULL
    WHERE id=p_id AND site_id=p_site_id AND lease_owner=p_owner;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.control_harness_session(p_id uuid, p_site_id uuid, p_action text, p_message text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.harness_sessions%ROWTYPE; s jsonb; result jsonb;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('pause','cancel','resume') OR length(p_message) > 20000
  THEN RAISE EXCEPTION 'Invalid harness control' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM public.harness_sessions WHERE id=p_id AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.snapshot->>'status' IN ('completed','cancelled')
    OR (p_action='resume' AND r.lease_expires_at > clock_timestamp()) THEN RETURN NULL; END IF;
  s := r.snapshot || jsonb_build_object('status',CASE p_action WHEN 'resume' THEN 'queued' WHEN 'pause' THEN 'paused' ELSE 'cancelled' END);
  -- Host service redacts before this RPC. Budgets, pending operations, uncertainty,
  -- workspace and request remain unchanged; resume grants no new budget.
  IF p_action='resume' AND p_message IS NOT NULL AND length(p_message)>0 THEN
    s := jsonb_set(s,'{messages}',(s->'messages') || jsonb_build_array(jsonb_build_object('role','user','content',p_message)));
  END IF;
  UPDATE public.harness_sessions SET version=version+1, lease_owner=NULL, lease_expires_at=NULL,
    snapshot=s || jsonb_build_object('version',version+1,'updatedAt',clock_timestamp())
    WHERE id=p_id AND site_id=p_site_id RETURNING snapshot INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.valid_harness_snapshot(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_harness_session() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_harness_session(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.save_harness_session(uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.renew_harness_session(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_harness_session(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.control_harness_session(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
-- CHECK constraints execute validation on service-role INSERT.
GRANT EXECUTE ON FUNCTION public.valid_harness_snapshot(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_harness_session(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_harness_session(uuid,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_harness_session(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_harness_session(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.control_harness_session(uuid,uuid,text,text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;