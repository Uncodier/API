-- Add fingerprint column to the visitors table
ALTER TABLE visitors
ADD COLUMN IF NOT EXISTS fingerprint TEXT;

-- Create an index on fingerprint for faster lookups
CREATE INDEX IF NOT EXISTS idx_visitors_fingerprint ON visitors(fingerprint);

-- Add comment to the column
COMMENT ON COLUMN visitors.fingerprint IS 'Unique browser/device fingerprint, used to link visitors across sessions';

-- If device_id column exists, migrate data to fingerprint column
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'visitors' AND column_name = 'device_id'
    ) THEN
        -- Update fingerprint with device_id values where device_id is not null
        UPDATE visitors 
        SET fingerprint = device_id 
        WHERE device_id IS NOT NULL AND fingerprint IS NULL;
        
        -- Drop device_id column
        ALTER TABLE visitors DROP COLUMN IF EXISTS device_id;
        
        -- Drop related index if exists
        DROP INDEX IF EXISTS idx_visitors_device_id;
    END IF;
END $$; 