-- Makinari only. Run outside any transaction, as a standalone statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS instance_logs_deletion_tool_requirement_idx
  ON public.instance_logs (lower(tool_args->>'requirement_id'))
  WHERE tool_args->>'requirement_id' IS NOT NULL;