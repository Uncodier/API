-- =====================================================================
-- Migrate Requirement Properties and Status Column
--
-- 1) Add `backlog` and `progress` columns to `requirements` table.
-- 2) Rename `status` column in `requirement_status` to `stage`.
-- 3) Update constraints on `requirement_status`.
--
-- NOTE: Data migration is handled by the `migrate_requirement_props.ts` script
-- using the Supabase Admin (Service Role) client to bypass RLS/Triggers.
-- =====================================================================

-- 1) Add new columns to `requirements`
ALTER TABLE public.requirements
ADD COLUMN IF NOT EXISTS backlog jsonb NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2) Rename `status` to `stage` in `requirement_status`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'requirement_status' 
      AND column_name = 'status'
  ) THEN
    ALTER TABLE public.requirement_status RENAME COLUMN status TO stage;
  END IF;
END $$;

-- 3) Update constraints on `requirement_status`
-- First, drop the old constraint if it exists (it might have been renamed or still using the old name)
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE t.relname = 'requirement_status'
    AND n.nspname = 'public'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.requirement_status DROP CONSTRAINT %I', cname);
  END IF;
  
  -- Also check for the specific constraint added in alter_requirement_status_needs_review.sql
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'requirement_status_status_check'
  ) THEN
    ALTER TABLE public.requirement_status DROP CONSTRAINT requirement_status_status_check;
  END IF;
END $$;

-- Add the new constraint for `stage`
ALTER TABLE public.requirement_status
ADD CONSTRAINT requirement_status_stage_check
CHECK (
  stage IN (
    'pending', 'in-progress', 'on-review', 'completed', 'done',
    'failed', 'blocked', 'paused', 'cancelled', 'backlog',
    'validated', 'needs_review'
  )
);
