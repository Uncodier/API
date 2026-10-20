-- Forward compatibility for projects that already installed the old function.
-- The failed 10300/10400 files are also corrected for a fresh migration sequence.
BEGIN;
SET LOCAL search_path = public, extensions, pg_temp;

DO $repair$
DECLARE
  v_function regprocedure;
  v_definition text;
BEGIN
  v_function := to_regprocedure('public.catalog_search_candidates(uuid,text,text,jsonb,text,vector,integer,double precision)');
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'Apply catalog search migrations 10300 and 10400 before 10500';
  END IF;
  v_definition := pg_get_functiondef(v_function);
  -- Keep SECURITY DEFINER, fixed search_path, signature, owner and existing ACLs.
  -- Strip only optional extension GUCs, including quoted pg_get_functiondef names.
  v_definition := regexp_replace(v_definition,
    E'\\n[ \\t]*SET "?(pg_trgm\\.word_similarity_threshold|hnsw\\.ef_search)"? TO [^\\n]*', '', 'g');
  v_definition := replace(v_definition, 'd.document_text %> v_query',
    'word_similarity(v_query, d.document_text) >= 0.5');
  EXECUTE v_definition;
END;
$repair$;

COMMIT;