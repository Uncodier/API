-- Fix infinite recursion causing stack depth exceeded on api_keys inserts

-- Drop problematic triggers if they exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'api_keys' AND t.tgname = 'check_expired_api_keys'
  ) THEN
    DROP TRIGGER check_expired_api_keys ON public.api_keys;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'api_keys' AND t.tgname = 'update_api_key_usage'
  ) THEN
    DROP TRIGGER update_api_key_usage ON public.api_keys;
  END IF;
END $$;

-- Create a safe row-level BEFORE trigger that only mutates NEW
CREATE OR REPLACE FUNCTION ensure_api_key_not_expired()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.expires_at IS NOT NULL AND NEW.expires_at < CURRENT_TIMESTAMP THEN
    NEW.status := 'expired';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

CREATE TRIGGER check_expired_api_keys
BEFORE INSERT OR UPDATE ON public.api_keys
FOR EACH ROW
EXECUTE FUNCTION ensure_api_key_not_expired();

-- Intentionally do NOT recreate update_api_key_usage to avoid self-updating recursion.
-- Application code will update last_used_at explicitly when validating a key.


