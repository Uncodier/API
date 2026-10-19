-- Makinari only. Run outside any transaction, as a standalone statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS instance_logs_deletion_details_requirement_camel_idx
  ON public.instance_logs (lower(details->>'requirementId'))
  WHERE details->>'requirementId' IS NOT NULL;