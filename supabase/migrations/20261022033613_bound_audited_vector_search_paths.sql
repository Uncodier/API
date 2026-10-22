-- Target: Makinari. Converge audited vector/record search paths only.
-- Preserve current SECURITY INVOKER mode, complete bodies, RLS and grants;
-- do NOT replay old SECURITY DEFINER declarations from historical files.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10s';
SET LOCAL search_path=public,extensions,pg_catalog;
CREATE TEMP TABLE audited_vector_contract ON COMMIT DROP AS
  SELECT oid,prosrc,proowner,proacl,prosecdef,provolatile,proisstrict
  FROM pg_proc WHERE oid IN ('public.commit_instance_context_memory(uuid,uuid,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,uuid,uuid[],text,vector)'::regprocedure,'public.match_instance_context_memories(uuid,uuid,vector,integer)'::regprocedure,'public.match_records_vector(uuid,double precision,integer)'::regprocedure,'public.get_records_similarity_edges(uuid,double precision,integer)'::regprocedure);
DO $preflight$
BEGIN
  IF current_user<>'postgres' OR EXISTS (SELECT 1 FROM (VALUES
    ('public.commit_instance_context_memory(uuid,uuid,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,uuid,uuid[],text,vector)','be95b869f494ee6acfc7200c1bf4455f',ARRAY['search_path=public, pg_temp']::text[],'{postgres=X/postgres,service_role=X/postgres}'),
    ('public.match_instance_context_memories(uuid,uuid,vector,integer)','5da7bc38b716b72e616947b237383a39',ARRAY['search_path=public, pg_temp']::text[],'{postgres=X/postgres,service_role=X/postgres}'),
    ('public.match_records_vector(uuid,double precision,integer)','54621a87862023a2d57ac53044e245be',NULL::text[],'{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.get_records_similarity_edges(uuid,double precision,integer)','f43237e512f2d015c9298e98efac7595',NULL::text[],'{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')) expected(signature,body_md5,config,acl)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
    WHERE p.oid IS NULL OR md5(p.prosrc)<>expected.body_md5 OR p.proowner<>'postgres'::regrole
      OR p.prosecdef OR p.proconfig IS DISTINCT FROM expected.config OR p.proacl::text IS DISTINCT FROM expected.acl) THEN
    RAISE EXCEPTION 'Vector search contract changed since migration audit';
  END IF;
END;
$preflight$;
ALTER FUNCTION public.commit_instance_context_memory(uuid,uuid,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,uuid,uuid[],text,vector) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.match_instance_context_memories(uuid,uuid,vector,integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.match_records_vector(uuid,double precision,integer) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.get_records_similarity_edges(uuid,double precision,integer) SET search_path = public, extensions, pg_temp;
DO $postflight$
BEGIN
  IF (SELECT count(*) FROM audited_vector_contract saved JOIN pg_proc p ON p.oid=saved.oid)<>4
    OR EXISTS (SELECT 1 FROM audited_vector_contract saved JOIN pg_proc p ON p.oid=saved.oid
      WHERE ROW(p.prosrc,p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proisstrict)
        IS DISTINCT FROM ROW(saved.prosrc,saved.proowner,saved.proacl,saved.prosecdef,saved.provolatile,saved.proisstrict)
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, extensions, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'Vector search path correction changed permissions or function behavior';
  END IF;
END;
$postflight$;
COMMIT;
