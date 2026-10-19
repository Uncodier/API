-- Makinari only. Run outside any transaction, as a standalone statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS instance_logs_deletion_tool_requirement_camel_idx
  ON public.instance_logs (lower(tool_args->>'requirementId'))
  WHERE tool_args->>'requirementId' IS NOT NULL;