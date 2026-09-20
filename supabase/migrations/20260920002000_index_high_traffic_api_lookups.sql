-- Rollback:
-- DROP INDEX IF EXISTS public.content_public_site_type_created_idx;
-- DROP INDEX IF EXISTS public.content_assets_content_id_idx;
-- DROP INDEX IF EXISTS public.secure_tokens_type_identifier_idx;
-- DROP INDEX IF EXISTS public.visitor_sessions_site_visitor_started_idx;

CREATE INDEX IF NOT EXISTS content_public_site_type_created_idx
  ON public.content (site_id, type, created_at DESC)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS content_assets_content_id_idx
  ON public.content_assets (content_id);

CREATE INDEX IF NOT EXISTS secure_tokens_type_identifier_idx
  ON public.secure_tokens (token_type, identifier);

CREATE INDEX IF NOT EXISTS visitor_sessions_site_visitor_started_idx
  ON public.visitor_sessions (site_id, visitor_id, started_at DESC);
