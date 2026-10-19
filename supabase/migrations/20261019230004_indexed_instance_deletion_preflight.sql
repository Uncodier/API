-- Makinari only. Requires the empty-scope correction and all four preceding indexes.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Concurrent expression indexes have no selectivity statistics until ANALYZE.
-- Refresh before installation; otherwise EXISTS can still prefer sequential scans.
ANALYZE public.instance_logs;

DO $migration$
DECLARE
  definition text;
  binding record;
  index_oid oid;
  old_query text := $old$SELECT 1 FROM public.instance_logs l
    WHERE cardinality(ids) > 0 AND l.instance_id <> i.id AND (
      lower(l.details->>'requirement_id') = ANY(ids::text[])
      OR lower(l.details->>'requirementId') = ANY(ids::text[])
      OR lower(l.tool_args->>'requirement_id') = ANY(ids::text[])
      OR lower(l.tool_args->>'requirementId') = ANY(ids::text[])
    )$old$;
  new_query text := $new$SELECT 1 FROM (
      SELECT l.instance_id FROM public.instance_logs l
      WHERE l.details->>'requirement_id' IS NOT NULL
        AND lower(l.details->>'requirement_id') = ANY(ids::text[])
      UNION ALL
      SELECT l.instance_id FROM public.instance_logs l
      WHERE l.details->>'requirementId' IS NOT NULL
        AND lower(l.details->>'requirementId') = ANY(ids::text[])
      UNION ALL
      SELECT l.instance_id FROM public.instance_logs l
      WHERE l.tool_args->>'requirement_id' IS NOT NULL
        AND lower(l.tool_args->>'requirement_id') = ANY(ids::text[])
      UNION ALL
      SELECT l.instance_id FROM public.instance_logs l
      WHERE l.tool_args->>'requirementId' IS NOT NULL
        AND lower(l.tool_args->>'requirementId') = ANY(ids::text[])
    ) tagged_logs
    WHERE cardinality(ids) > 0 AND tagged_logs.instance_id <> i.id$new$;
BEGIN
  -- IF NOT EXISTS cannot repair an interrupted concurrent build or a wrong index.
  -- Refuse to install the query until every required index is valid and exact.
  FOR binding IN SELECT * FROM (VALUES
    ('instance_logs_deletion_details_requirement_idx', 'details', 'requirement_id'),
    ('instance_logs_deletion_details_requirement_camel_idx', 'details', 'requirementId'),
    ('instance_logs_deletion_tool_requirement_idx', 'tool_args', 'requirement_id'),
    ('instance_logs_deletion_tool_requirement_camel_idx', 'tool_args', 'requirementId')
  ) required(index_name, column_name, tag_name)
  LOOP
    index_oid := pg_catalog.to_regclass('public.' || binding.index_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_index ix
      JOIN pg_catalog.pg_class c ON c.oid = ix.indexrelid
      JOIN pg_catalog.pg_am am ON am.oid = c.relam
      WHERE ix.indexrelid = index_oid AND ix.indrelid = 'public.instance_logs'::regclass
        AND ix.indisvalid AND ix.indisready AND NOT ix.indisunique
        AND ix.indnatts = 1 AND ix.indnkeyatts = 1 AND am.amname = 'btree'
        AND ix.indcollation[0] = (SELECT typcollation FROM pg_catalog.pg_type WHERE oid = 'text'::regtype)
        AND ix.indclass[0] = (SELECT oid FROM pg_catalog.pg_opclass
          WHERE opcmethod = am.oid AND opcintype = 'text'::regtype AND opcdefault)
        AND pg_catalog.pg_get_expr(ix.indexprs, ix.indrelid) =
          format('lower((%I ->> %L::text))', binding.column_name, binding.tag_name)
        AND pg_catalog.pg_get_expr(ix.indpred, ix.indrelid) =
          format('((%I ->> %L::text) IS NOT NULL)', binding.column_name, binding.tag_name)
    ) THEN
      RAISE EXCEPTION 'Missing, invalid or incompatible deletion index: %', binding.index_name;
    END IF;
  END LOOP;

  definition := pg_catalog.pg_get_functiondef(
    'public.get_robot_instance_deletion_scope(uuid)'::regprocedure
  );
  IF strpos(definition, old_query) > 0 THEN
    -- Preserve deployed status fixes, authorization, ACLs and all other guards.
    EXECUTE replace(definition, old_query, new_query);
  ELSIF strpos(definition, new_query) = 0 THEN
    RAISE EXCEPTION 'Unexpected deletion preflight definition; review before migration';
  END IF;
END;
$migration$;

COMMIT;