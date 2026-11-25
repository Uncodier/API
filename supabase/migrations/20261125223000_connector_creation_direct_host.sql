BEGIN;
SET LOCAL lock_timeout = '5s';

-- The two known finalizers differ in their initial catalog_reads setting.
-- Preserve the installed contract, privileges and opt-outs; change only the
-- verified-new-account host list. Unknown source requires a separate review.
DO $migration$
DECLARE
  target regprocedure := 'public.connector_finalize_auth(uuid,uuid,text,text,text,text,text,text[])'::regprocedure;
  definition text := pg_get_functiondef(target);
  old_fragment constant text := $old$v_allowed_tools, ARRAY['assistant'], cardinality(v_allowed_tools)$old$;
  new_fragment constant text := $new$v_allowed_tools, ARRAY['assistant','direct'], cardinality(v_allowed_tools)$new$;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid=target AND encode(sha256(convert_to(prosrc,'UTF8')),'hex') IN (
    'ed54b19f96da07cb5c3696430c26a43677dd5ec920eda36f82cab1855b47d44e', -- project-binding finalizer
    '8cddee33be4792504af93ca2218be46e5d21d22b4a70e7907f4b003a9ef4cf1b'  -- catalog-reads-on-creation finalizer
  )) OR cardinality(string_to_array(definition,old_fragment)) <> 2 THEN
    RAISE EXCEPTION 'Unrecognized connector finalizer. No host default changed.';
  END IF;
  EXECUTE replace(definition,old_fragment,new_fragment);
END $migration$;
COMMIT;
