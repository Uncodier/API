-- Migration: Fix api_keys functions under secured search_path
-- Context: Previous security hardening set `SET search_path = ''` on functions,
-- but the functions referenced tables without schema qualification, causing
-- `relation "api_keys" does not exist` at runtime when triggers fired.

-- Ensure functions reference fully-qualified tables while keeping search_path locked down

-- Fix expire_old_api_keys to reference public.api_keys explicitly
CREATE OR REPLACE FUNCTION expire_old_api_keys()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.api_keys
    SET status = 'expired'
    WHERE status = 'active'
      AND expires_at < CURRENT_TIMESTAMP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

-- Fix update_api_key_last_used to reference public.api_keys explicitly
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

-- Notes:
-- - Triggers using these functions will pick up the replacements automatically.
-- - No data changes are performed; only function definitions are updated.


