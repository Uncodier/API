-- Rollback:
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_events_recording_session
--   ON public.session_events (session_id)
--   WHERE event_type = 'session_recording';

DROP INDEX CONCURRENTLY IF EXISTS public.idx_session_events_recording_session;
