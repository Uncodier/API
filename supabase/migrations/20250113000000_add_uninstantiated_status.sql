-- Migration: Add 'uninstantiated' status to remote_instances
-- Purpose: Support assistant mode without Scrapybara provisioning
-- Date: 2025-01-13

-- Drop the existing CHECK constraint
ALTER TABLE remote_instances
DROP CONSTRAINT IF EXISTS remote_instances_status_check;

-- Add the new CHECK constraint with 'uninstantiated' status
ALTER TABLE remote_instances
ADD CONSTRAINT remote_instances_status_check
CHECK (status = ANY (ARRAY[
  'pending'::text,
  'starting'::text,
  'running'::text,
  'paused'::text,
  'stopping'::text,
  'stopped'::text,
  'error'::text,
  'uninstantiated'::text
]));

-- Add comment
COMMENT ON CONSTRAINT remote_instances_status_check ON remote_instances IS 
'Status constraint including uninstantiated for assistant mode without Scrapybara provisioning';

