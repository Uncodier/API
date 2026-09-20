-- Rollback:
-- DROP INDEX IF EXISTS public.allowed_domains_domain_lookup_idx;
-- DROP INDEX IF EXISTS public.sites_url_lookup_idx;

CREATE INDEX IF NOT EXISTS sites_url_lookup_idx
  ON public.sites (url);

CREATE INDEX IF NOT EXISTS allowed_domains_domain_lookup_idx
  ON public.allowed_domains
  (domain);
