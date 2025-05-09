-- Add identified_at column to visitor_sessions table
ALTER TABLE visitor_sessions
ADD COLUMN IF NOT EXISTS identified_at BIGINT;

-- Add lead_data column if it doesn't exist
ALTER TABLE visitor_sessions
ADD COLUMN IF NOT EXISTS lead_data JSONB;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_identified_at ON visitor_sessions(identified_at);
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_lead_id ON visitor_sessions(lead_id);

-- Add comments to explain the columns
COMMENT ON COLUMN visitor_sessions.identified_at IS 'Timestamp when the visitor was identified with a lead';
COMMENT ON COLUMN visitor_sessions.lead_data IS 'Additional data associated with the lead'; 