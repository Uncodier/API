-- Update session_events table structure
ALTER TABLE session_events
ADD COLUMN IF NOT EXISTS site_id text NOT NULL,
ADD COLUMN IF NOT EXISTS visitor_id text,
ADD COLUMN IF NOT EXISTS referrer text,
ADD COLUMN IF NOT EXISTS user_agent text,
ADD COLUMN IF NOT EXISTS ip text,
ADD COLUMN IF NOT EXISTS event_name text,
ADD COLUMN IF NOT EXISTS properties jsonb DEFAULT '{}'::jsonb;

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_session_events_site_id ON session_events(site_id);
CREATE INDEX IF NOT EXISTS idx_session_events_visitor_id ON session_events(visitor_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_event_type ON session_events(event_type);
CREATE INDEX IF NOT EXISTS idx_session_events_timestamp ON session_events(timestamp);

-- Add comment to the table
COMMENT ON TABLE session_events IS 'Stores visitor events and tracking data';

-- Add comments to columns
COMMENT ON COLUMN session_events.id IS 'Unique identifier for the event';
COMMENT ON COLUMN session_events.event_id IS 'External event identifier';
COMMENT ON COLUMN session_events.session_id IS 'Session identifier';
COMMENT ON COLUMN session_events.event_type IS 'Type of event (pageview, click, custom, etc.)';
COMMENT ON COLUMN session_events.url IS 'URL where the event occurred';
COMMENT ON COLUMN session_events.timestamp IS 'Event timestamp in milliseconds';
COMMENT ON COLUMN session_events.data IS 'Raw event data';
COMMENT ON COLUMN session_events.created_at IS 'Record creation timestamp';
COMMENT ON COLUMN session_events.updated_at IS 'Record last update timestamp';
COMMENT ON COLUMN session_events.site_id IS 'Site identifier';
COMMENT ON COLUMN session_events.visitor_id IS 'Visitor identifier';
COMMENT ON COLUMN session_events.referrer IS 'Referrer URL';
COMMENT ON COLUMN session_events.user_agent IS 'User agent string';
COMMENT ON COLUMN session_events.ip IS 'IP address';
COMMENT ON COLUMN session_events.event_name IS 'Custom event name';
COMMENT ON COLUMN session_events.properties IS 'Event properties as JSON';

-- Add RLS policies
ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for authenticated users" ON session_events
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Enable insert for authenticated users" ON session_events
    FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- Add function to handle event insertion
CREATE OR REPLACE FUNCTION handle_event_insert()
RETURNS TRIGGER AS $$
BEGIN
    -- Set created_at and updated_at timestamps
    NEW.created_at = COALESCE(NEW.created_at, NOW());
    NEW.updated_at = NOW();
    
    -- Ensure data is a valid JSONB
    IF NEW.data IS NULL THEN
        NEW.data = '{}'::jsonb;
    END IF;
    
    -- Ensure properties is a valid JSONB
    IF NEW.properties IS NULL THEN
        NEW.properties = '{}'::jsonb;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for event insertion
DROP TRIGGER IF EXISTS on_event_insert ON session_events;
CREATE TRIGGER on_event_insert
    BEFORE INSERT ON session_events
    FOR EACH ROW
    EXECUTE FUNCTION handle_event_insert(); 