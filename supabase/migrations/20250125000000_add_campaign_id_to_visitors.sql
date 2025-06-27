-- Add campaign_id column to the visitors table
ALTER TABLE visitors
ADD COLUMN IF NOT EXISTS campaign_id UUID;

-- Add foreign key constraint to campaigns table
ALTER TABLE visitors
ADD CONSTRAINT IF NOT EXISTS visitors_campaign_id_fkey 
FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;

-- Create an index on campaign_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_visitors_campaign_id ON visitors(campaign_id);

-- Add comment to the column
COMMENT ON COLUMN visitors.campaign_id IS 'Reference to the campaign that acquired this visitor'; 