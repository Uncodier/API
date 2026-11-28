-- Build outside a transaction to keep status writers online. The primary key
-- orders every status; this smaller index walks only rows that protect resources.
CREATE INDEX CONCURRENTLY requirement_status_housekeeping_refs_idx
  ON public.requirement_status (id)
  WHERE active_sandbox_id IS NOT NULL OR snapshot_id IS NOT NULL;
