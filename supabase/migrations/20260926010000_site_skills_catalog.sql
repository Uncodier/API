-- Site-owned Agent Skills. Only trusted server code (service role) may read/write.
BEGIN;
CREATE TABLE public.site_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 100),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  types text[] NOT NULL DEFAULT '{}',
  content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 131072),
  source text NOT NULL DEFAULT 'custom' CHECK (source IN ('custom', 'github')),
  source_url text,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, slug),
  CHECK (source <> 'github' OR source_url IS NOT NULL)
);
CREATE UNIQUE INDEX site_skills_source_url_unique ON public.site_skills (site_id, source_url) WHERE source_url IS NOT NULL;
CREATE INDEX site_skills_site_created_idx ON public.site_skills (site_id, created_at DESC);
ALTER TABLE public.site_skills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.site_skills FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.site_skills TO service_role;
COMMIT;