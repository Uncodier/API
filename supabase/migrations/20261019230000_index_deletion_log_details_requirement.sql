-- Makinari only. Run outside any transaction, as a standalone statement.
-- Partial expression indexes cover every log type, not only user actions.
CREATE INDEX CONCURRENTLY IF NOT EXISTS instance_logs_deletion_details_requirement_idx
  ON public.instance_logs (lower(details->>'requirement_id'))
  WHERE details->>'requirement_id' IS NOT NULL;