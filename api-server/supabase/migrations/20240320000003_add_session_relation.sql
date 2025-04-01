-- Add session_id column to session_events table
ALTER TABLE session_events
ADD COLUMN IF NOT EXISTS session_id uuid;

-- Add foreign key constraint to link session_events with visitor_sessions
ALTER TABLE session_events
ADD CONSTRAINT fk_visitor_session
FOREIGN KEY (session_id)
REFERENCES visitor_sessions(id)
ON DELETE CASCADE;

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id);

-- Add comment to explain the relationship
COMMENT ON CONSTRAINT fk_visitor_session ON session_events IS 'Links session_events to visitor_sessions table';

-- Add comment to the column
COMMENT ON COLUMN session_events.session_id IS 'Reference to visitor_sessions table'; 