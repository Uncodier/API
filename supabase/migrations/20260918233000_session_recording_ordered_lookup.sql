-- Rollback:
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_session_events_recording_ordered;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_events_recording_ordered
  ON public.session_events (session_id, created_at, id)
  WHERE event_type = 'session_recording' AND session_id IS NOT NULL;
