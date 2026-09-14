-- Drop the existing constraint if it exists
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirements_status_check') THEN
    ALTER TABLE public.requirements DROP CONSTRAINT requirements_status_check;
  END IF;
END $$;

-- Add the updated constraint with 'cancelled' (double l) and 'blocked'
ALTER TABLE public.requirements ADD CONSTRAINT requirements_status_check 
  CHECK (status = ANY (ARRAY['validated'::text, 'in-progress'::text, 'on-review'::text, 'done'::text, 'backlog'::text, 'canceled'::text, 'cancelled'::text, 'blocked'::text]));

-- Add metadata column to remote_instances if it doesn't exist
ALTER TABLE public.remote_instances ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
