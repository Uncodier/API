-- Rollback:
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_session_events_recording_session;

-- Accelerates the hot recording metadata lookup without indexing unrelated
-- click, pageview, scroll, or custom events.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_events_recording_session
  ON public.session_events (session_id)
  WHERE event_type = 'session_recording';
