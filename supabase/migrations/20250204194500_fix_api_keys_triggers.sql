-- Fix misconfigured triggers on public.api_keys that were cancelling inserts
-- Root cause: trigger "check_expired_api_keys" was BEFORE INSERT/UPDATE and
-- calls expire_old_api_keys() which RETURNS NULL; in a BEFORE trigger this
-- skips the row and the insert never happens. Recreate it as AFTER.

-- Drop wrong triggers if present
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

-- Recreate correct triggers

-- Ensure function has secured search_path and correct body
CREATE OR REPLACE FUNCTION expire_old_api_keys()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.api_keys
  SET status = 'expired'
  WHERE status = 'active'
    AND expires_at < CURRENT_TIMESTAMP;
  RETURN NULL; -- AFTER trigger, return value ignored
END;
$$ LANGUAGE plpgsql
SET search_path = '';

-- AFTER trigger so it never cancels inserts
CREATE TRIGGER check_expired_api_keys
AFTER INSERT OR UPDATE ON public.api_keys
FOR EACH STATEMENT
EXECUTE FUNCTION expire_old_api_keys();

-- Keep usage updater safe: only react after explicit updates to last_used_at
CREATE OR REPLACE FUNCTION update_api_key_last_used()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.api_keys
  SET last_used_at = CURRENT_TIMESTAMP
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

CREATE TRIGGER update_api_key_usage
AFTER UPDATE OF last_used_at ON public.api_keys
FOR EACH ROW
EXECUTE FUNCTION update_api_key_last_used();


