-- Cloud sessions retain the canonical lifecycle without a workspace repository.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.valid_harness_snapshot(s jsonb)
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
    OR jsonb_typeof(s->'createdAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(s->'updatedAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(s->'messages') IS DISTINCT FROM 'array'
    OR jsonb_typeof(s->'uncertainOperations') IS DISTINCT FROM 'array'
  THEN RETURN false; END IF;
  IF (s->'request') ? 'executionEnvironment' AND
    (jsonb_typeof(s#>'{request,executionEnvironment}') IS DISTINCT FROM 'string'
      OR s#>>'{request,executionEnvironment}' NOT IN ('cloud','workspace')) THEN RETURN false; END IF;
  IF s#>>'{request,executionEnvironment}' = 'cloud' THEN
    IF (s->'request') ? 'repository' OR s ? 'workspace' THEN RETURN false; END IF;
    IF (s->'request') ? 'cloudInstanceId' AND
      (jsonb_typeof(s#>'{request,cloudInstanceId}') IS DISTINCT FROM 'string' OR
        s#>>'{request,cloudInstanceId}' !~ '^[0-9a-fA-F-]{36}$') THEN RETURN false; END IF;
  ELSIF jsonb_typeof(s#>'{request,repository,url}') IS DISTINCT FROM 'string'
    OR length(s#>>'{request,repository,url}') NOT BETWEEN 1 AND 4000 THEN RETURN false;
  END IF;
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


CREATE FUNCTION public.guard_requirement_execution_environment()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE current_mode text; previous_mode text;
BEGIN
  current_mode := COALESCE(NEW.metadata->>'execution_environment','workspace');
  IF current_mode NOT IN ('cloud','workspace') OR
    (NEW.metadata ? 'execution_environment' AND jsonb_typeof(NEW.metadata->'execution_environment') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'invalid requirement execution environment' USING ERRCODE='22023';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    previous_mode := COALESCE(OLD.metadata->>'execution_environment','workspace');
    IF current_mode IS DISTINCT FROM previous_mode THEN
      RAISE EXCEPTION 'requirement execution environment is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_requirement_execution_environment() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER requirement_execution_environment_guard BEFORE INSERT OR UPDATE OF metadata
ON public.requirements FOR EACH ROW EXECUTE FUNCTION public.guard_requirement_execution_environment();
COMMIT;
