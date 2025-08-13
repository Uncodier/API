-- Create visitors table
-- This table stores unique visitors across all sites
-- Device, browser, and location data are stored in visitor_sessions table for multi-device tracking

CREATE TABLE IF NOT EXISTS public.visitors (
  id UUID NOT NULL PRIMARY KEY,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  total_sessions INTEGER DEFAULT 1,
  total_page_views INTEGER DEFAULT 0,
  total_time_spent BIGINT DEFAULT 0,
  first_url TEXT,
  first_referrer TEXT,
  first_utm_source TEXT,
  first_utm_medium TEXT,
  first_utm_campaign TEXT,
  first_utm_term TEXT,
  first_utm_content TEXT,
  custom_data JSONB,
  lead_id UUID,
  is_identified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  fingerprint TEXT,
  command_id UUID,
  segment_id UUID,
  
  -- Foreign key constraints
  CONSTRAINT fk_command_visitors FOREIGN KEY (command_id) REFERENCES public.commands(id) ON DELETE SET NULL,
  CONSTRAINT visitors_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id) ON DELETE SET NULL
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_visitors_fingerprint ON public.visitors(fingerprint);
CREATE INDEX IF NOT EXISTS idx_visitors_is_identified ON public.visitors(is_identified);
CREATE INDEX IF NOT EXISTS idx_visitors_lead_id ON public.visitors(lead_id);
CREATE INDEX IF NOT EXISTS idx_visitors_command_id ON public.visitors(command_id);
CREATE INDEX IF NOT EXISTS idx_visitors_segment_id ON public.visitors(segment_id);
CREATE INDEX IF NOT EXISTS idx_visitors_first_seen_at ON public.visitors(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_visitors_last_seen_at ON public.visitors(last_seen_at);

-- Add comments
COMMENT ON TABLE public.visitors IS 'Stores unique visitors across all sites. Device, browser, and location data are stored in visitor_sessions for multi-device tracking';
COMMENT ON COLUMN public.visitors.id IS 'Unique identifier for the visitor';
COMMENT ON COLUMN public.visitors.fingerprint IS 'Unique browser/device fingerprint, used to link visitors across sessions';
COMMENT ON COLUMN public.visitors.first_seen_at IS 'Timestamp when the visitor was first seen';
COMMENT ON COLUMN public.visitors.last_seen_at IS 'Timestamp when the visitor was last seen';
COMMENT ON COLUMN public.visitors.total_sessions IS 'Total number of sessions for this visitor';
COMMENT ON COLUMN public.visitors.total_page_views IS 'Total page views across all sessions';
COMMENT ON COLUMN public.visitors.total_time_spent IS 'Total time spent on site in milliseconds';
COMMENT ON COLUMN public.visitors.is_identified IS 'Whether the visitor has been identified as a lead';
COMMENT ON COLUMN public.visitors.lead_id IS 'Reference to the lead if visitor is identified';
COMMENT ON COLUMN public.visitors.segment_id IS 'Reference to the segment this visitor belongs to';
