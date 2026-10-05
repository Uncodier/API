-- Makinari only. Preserve authorization, ownership checks, grants and live fixes.
-- The prior LATERAL expansion scans unrelated logs even for an empty UUID set.
BEGIN;

DO $migration$
DECLARE
  definition text;
  old_query text := $old$SELECT 1 FROM public.instance_logs l CROSS JOIN LATERAL unnest(ARRAY[
      l.details->>'requirement_id', l.details->>'requirementId',
      l.tool_args->>'requirement_id', l.tool_args->>'requirementId'
    ]) tags(value) WHERE l.instance_id <> i.id AND lower(value) = ANY(ids::text[])$old$;
  new_query text := $new$SELECT 1 FROM public.instance_logs l
    WHERE cardinality(ids) > 0 AND l.instance_id <> i.id AND (
      lower(l.details->>'requirement_id') = ANY(ids::text[])
      OR lower(l.details->>'requirementId') = ANY(ids::text[])
      OR lower(l.tool_args->>'requirement_id') = ANY(ids::text[])
      OR lower(l.tool_args->>'requirementId') = ANY(ids::text[])
    )$new$;
BEGIN
  definition := pg_catalog.pg_get_functiondef(
    'public.get_robot_instance_deletion_scope(uuid)'::regprocedure
  );
  IF strpos(definition, old_query) > 0 THEN
    -- Change only this reviewed query, never overwrite unrelated deployed fixes.
    EXECUTE replace(definition, old_query, new_query);
  ELSIF strpos(definition, new_query) = 0 THEN
    RAISE EXCEPTION 'Unexpected deletion preflight definition; review before migration';
  END IF;
END;
$migration$;

COMMIT;