-- Migration: Add 'paused' and 'replaced' statuses to instance_plans
-- Purpose: Support plan pause/resume functionality and plan replacement tracking
-- Date: 2025-01-06

-- Drop the existing CHECK constraint
ALTER TABLE instance_plans
DROP CONSTRAINT IF EXISTS instance_plans_status_check;

-- Add the new CHECK constraint with 'paused' and 'replaced' statuses
ALTER TABLE instance_plans
ADD CONSTRAINT instance_plans_status_check
CHECK (status = ANY (ARRAY[
  'pending'::text,
  'in_progress'::text,
  'completed'::text,
  'failed'::text,
  'cancelled'::text,
  'blocked'::text,
  'paused'::text,
  'replaced'::text
]));

-- Add new columns to track pause/resume and replacement
ALTER TABLE instance_plans
ADD COLUMN IF NOT EXISTS paused_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS resumed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS replaced_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS replacement_reason TEXT,
ADD COLUMN IF NOT EXISTS completion_reason TEXT;

-- Add index for status to improve query performance
CREATE INDEX IF NOT EXISTS idx_instance_plans_status ON instance_plans(status);
CREATE INDEX IF NOT EXISTS idx_instance_plans_instance_status ON instance_plans(instance_id, status);

-- Add comments
COMMENT ON COLUMN instance_plans.paused_at IS 'Timestamp when the plan was paused';
COMMENT ON COLUMN instance_plans.resumed_at IS 'Timestamp when the plan was resumed after being paused';
COMMENT ON COLUMN instance_plans.replaced_at IS 'Timestamp when the plan was replaced by a new plan';
COMMENT ON COLUMN instance_plans.replacement_reason IS 'Reason why the plan was replaced';
COMMENT ON COLUMN instance_plans.completion_reason IS 'Reason why the plan was completed or auto-completed';

