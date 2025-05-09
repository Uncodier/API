-- Drop the foreign key constraint from session_events to sessions
ALTER TABLE session_events DROP CONSTRAINT IF EXISTS fk_session;

-- Drop the policy that depends on sessions table
DROP POLICY IF EXISTS session_events_site_owner_policy ON session_events;

-- Now we can safely drop the sessions table
DROP TABLE IF EXISTS sessions; 