-- Migration: Create synced_objects table for tracking processed emails and preventing duplications
-- File: 20241220000000_create_synced_objects_table.sql

-- Create synced_objects table
CREATE TABLE IF NOT EXISTS synced_objects (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    
    -- Core identification fields
    external_id TEXT NOT NULL, -- ID del email (messageId, uid, etc.)
    site_id UUID NOT NULL,
    object_type TEXT NOT NULL DEFAULT 'email', -- 'email', 'contact', 'task', etc.
    
    -- Processing status and metadata
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'processed', 'replied', 'error', 'skipped'
    provider TEXT, -- 'gmail', 'outlook', 'imap', etc.
    
    -- Tracking fields
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_processed_at TIMESTAMPTZ,
    process_count INTEGER DEFAULT 0,
    
    -- Additional data
    metadata JSONB DEFAULT '{}', -- Para guardar información adicional como subject, from, etc.
    error_message TEXT, -- Para errores de procesamiento
    
    -- Audit fields
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_synced_objects_external_id ON synced_objects(external_id);
CREATE INDEX IF NOT EXISTS idx_synced_objects_site_id ON synced_objects(site_id);
CREATE INDEX IF NOT EXISTS idx_synced_objects_object_type ON synced_objects(object_type);
CREATE INDEX IF NOT EXISTS idx_synced_objects_status ON synced_objects(status);
CREATE INDEX IF NOT EXISTS idx_synced_objects_provider ON synced_objects(provider);

-- Composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_synced_objects_site_object_type ON synced_objects(site_id, object_type);
CREATE INDEX IF NOT EXISTS idx_synced_objects_site_status ON synced_objects(site_id, status);
CREATE INDEX IF NOT EXISTS idx_synced_objects_external_site_type ON synced_objects(external_id, site_id, object_type);

-- Create unique constraint to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_synced_objects_unique_external_site_type 
ON synced_objects(external_id, site_id, object_type);

-- Create foreign key constraint to sites table (if exists)
-- ALTER TABLE synced_objects ADD CONSTRAINT fk_synced_objects_site_id 
-- FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;

-- Create function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_synced_objects_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update updated_at
CREATE TRIGGER trigger_update_synced_objects_updated_at
    BEFORE UPDATE ON synced_objects
    FOR EACH ROW
    EXECUTE FUNCTION update_synced_objects_updated_at();

-- Add comments for documentation
COMMENT ON TABLE synced_objects IS 'Tracks processed objects (emails, contacts, etc.) to prevent duplications and provide processing history';
COMMENT ON COLUMN synced_objects.external_id IS 'External identifier of the object (email messageId, contact id, etc.)';
COMMENT ON COLUMN synced_objects.site_id IS 'Site/workspace this object belongs to';
COMMENT ON COLUMN synced_objects.object_type IS 'Type of object being tracked (email, contact, task, etc.)';
COMMENT ON COLUMN synced_objects.status IS 'Current processing status';
COMMENT ON COLUMN synced_objects.provider IS 'Source provider (gmail, outlook, imap, etc.)';
COMMENT ON COLUMN synced_objects.metadata IS 'Additional object data in JSON format';
COMMENT ON COLUMN synced_objects.process_count IS 'Number of times this object has been processed';

-- Insert example data (optional, remove in production)
-- INSERT INTO synced_objects (external_id, site_id, object_type, status, provider, metadata) VALUES
-- ('example_email_123', gen_random_uuid(), 'email', 'processed', 'gmail', '{"subject": "Test Email", "from": "test@example.com"}'); 