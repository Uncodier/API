-- Permit one evidence row beyond the public 200-candidate window.
-- Keep the existing retrieval/eligibility predicates and 800-row semantic scan bound.
BEGIN;
SET LOCAL search_path = public, extensions, pg_temp;

DO $probe$
DECLARE
  v_function regprocedure;
  v_definition text;
BEGIN
  v_function := to_regprocedure('public.catalog_search_candidates(uuid,text,text,jsonb,text,vector,integer,double precision)');
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'Apply catalog search migrations through 10500 before 10600';
  END IF;
  v_definition := pg_get_functiondef(v_function);
  IF position('p_limit NOT BETWEEN 1 AND 200' IN v_definition) = 0
    AND position('p_limit NOT BETWEEN 1 AND 201' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected catalog candidate limit guard; review before applying 10600';
  END IF;
  -- CREATE OR REPLACE preserves signature, owner, ACLs, SECURITY DEFINER and search_path.
  v_definition := replace(v_definition, 'p_limit NOT BETWEEN 1 AND 200', 'p_limit NOT BETWEEN 1 AND 201');
  EXECUTE v_definition;
END;
$probe$;

COMMIT;