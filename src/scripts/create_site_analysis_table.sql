-- Create site_analysis table
CREATE TABLE IF NOT EXISTS public.site_analysis (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id UUID NOT NULL,
  url_path TEXT NOT NULL,
  structure JSONB NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'processing')),
  request_time INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL
);

-- Add comment to table
COMMENT ON TABLE public.site_analysis IS 'Stores site analysis data and results';

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_site_analysis_site_id ON public.site_analysis(site_id);
CREATE INDEX IF NOT EXISTS idx_site_analysis_user_id ON public.site_analysis(user_id);
CREATE INDEX IF NOT EXISTS idx_site_analysis_status ON public.site_analysis(status);

-- Add RLS policies
ALTER TABLE public.site_analysis ENABLE ROW LEVEL SECURITY;

-- Policy for users to see only their own analyses
CREATE POLICY "Users can view their own analyses"
  ON public.site_analysis
  FOR SELECT
  USING (auth.uid() = user_id);

-- Policy for users to insert their own analyses
CREATE POLICY "Users can insert their own analyses"
  ON public.site_analysis
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Policy for users to update their own analyses
CREATE POLICY "Users can update their own analyses"
  ON public.site_analysis
  FOR UPDATE
  USING (auth.uid() = user_id);

-- Foreign key constraints (uncomment if these tables exist)
-- ALTER TABLE public.site_analysis ADD CONSTRAINT fk_site
--   FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;
-- 
-- ALTER TABLE public.site_analysis ADD CONSTRAINT fk_user
--   FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER on_site_analysis_update
  BEFORE UPDATE ON public.site_analysis
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at(); 