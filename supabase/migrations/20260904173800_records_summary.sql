-- Add summary column to records table
-- Rollback: ALTER TABLE public.records DROP COLUMN IF EXISTS summary;

ALTER TABLE public.records 
ADD COLUMN IF NOT EXISTS summary text;
