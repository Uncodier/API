-- Remove event_id column from session_events table
ALTER TABLE session_events DROP COLUMN IF EXISTS event_id; 