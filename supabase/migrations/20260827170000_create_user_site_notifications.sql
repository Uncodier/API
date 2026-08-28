-- Migration to add user_site_notifications table for per-site notification preferences

CREATE TABLE IF NOT EXISTS public.user_site_notifications (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  email_enabled boolean NOT NULL DEFAULT true,
  push_enabled boolean NOT NULL DEFAULT true,
  categories jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_site_notifications_pkey PRIMARY KEY (user_id, site_id)
);

COMMENT ON TABLE public.user_site_notifications IS 'Stores user notification preferences per site, including category-specific toggles.';

ALTER TABLE public.user_site_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own site notifications"
  ON public.user_site_notifications
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own site notifications"
  ON public.user_site_notifications
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own site notifications"
  ON public.user_site_notifications
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE ON TABLE public.user_site_notifications TO authenticated;
GRANT ALL ON TABLE public.user_site_notifications TO service_role;

CREATE TRIGGER trg_user_site_notifications_set_updated_at
  BEFORE UPDATE ON public.user_site_notifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
