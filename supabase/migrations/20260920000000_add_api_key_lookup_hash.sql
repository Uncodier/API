-- Rollback:
-- DROP INDEX IF EXISTS public.api_keys_lookup_hash_unique;
-- ALTER TABLE public.api_keys DROP COLUMN IF EXISTS lookup_hash;

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS lookup_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_lookup_hash_unique
  ON public.api_keys (lookup_hash)
  WHERE lookup_hash IS NOT NULL;

COMMENT ON COLUMN public.api_keys.lookup_hash IS
  'SHA-256 digest used for indexed API-key lookup; encrypted key material remains in key_hash.';
