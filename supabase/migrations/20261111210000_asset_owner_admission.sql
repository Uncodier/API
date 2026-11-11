-- Add inline text support and a narrow fallback for missing asset ownership.
-- Existing rows, RLS, NOT NULL constraints and foreign keys remain unchanged.
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS content text;

CREATE OR REPLACE FUNCTION public.assign_missing_asset_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_role text := COALESCE(NULLIF(current_setting('role', true), 'none'), session_user);
  v_site uuid;
  v_owner uuid;
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF v_role IN ('postgres', 'supabase_admin', 'service_role') THEN
    IF NEW.instance_id IS NOT NULL THEN
      SELECT i.site_id, i.user_id INTO v_site, v_owner
      FROM public.remote_instances AS i WHERE i.id = NEW.instance_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset instance not found' USING ERRCODE = '23503';
      END IF;
      IF v_site IS DISTINCT FROM NEW.site_id THEN
        RAISE EXCEPTION 'Asset instance belongs to another site' USING ERRCODE = '23514';
      END IF;
      NEW.user_id := v_owner;
    ELSE
      SELECT s.user_id INTO NEW.user_id FROM public.sites AS s WHERE s.id = NEW.site_id;
    END IF;
  ELSE
    -- Client writes remain subject to the existing asset RLS policies.
    NEW.user_id := auth.uid();
  END IF;

  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'Asset owner could not be resolved' USING ERRCODE = '23502';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_missing_asset_owner() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS assets_assign_missing_owner ON public.assets;
CREATE TRIGGER assets_assign_missing_owner
BEFORE INSERT ON public.assets
FOR EACH ROW EXECUTE FUNCTION public.assign_missing_asset_owner();