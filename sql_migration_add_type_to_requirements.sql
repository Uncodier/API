-- Migration: Add type column to requirements table
-- Description: Adds a type field to categorize requirements by their nature (content, design, research, etc.)

-- Create the enum type for requirement types
CREATE TYPE requirement_type AS ENUM (
  'content',
  'design', 
  'research',
  'follow_up',
  'task',
  'develop',
  'analytics',
  'testing',
  'approval',
  'coordination',
  'strategy',
  'optimization',
  'automation',
  'integration',
  'planning',
  'payment'
);

-- Add the type column to the requirements table
ALTER TABLE requirements 
ADD COLUMN type requirement_type DEFAULT 'task';

-- Add index for better query performance
CREATE INDEX idx_requirements_type ON requirements(type);

-- Add a comment to document the column
COMMENT ON COLUMN requirements.type IS 'Categorizes the requirement by its nature (content creation, design work, research, etc.)';

-- Update existing requirements to have a default type of 'task'
UPDATE requirements SET type = 'task' WHERE type IS NULL; 