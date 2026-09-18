-- Rollback:
-- DROP INDEX IF EXISTS public.idx_session_events_retention_created_at;

-- Supports the daily 30-day retention sweep across all non-exempt sites.
CREATE INDEX IF NOT EXISTS idx_session_events_retention_created_at
  ON public.session_events (created_at, id);
