-- Rollback:
-- DROP FUNCTION IF EXISTS public.claim_synced_objects_batch(uuid, text, jsonb);
-- ALTER TABLE public.synced_objects
--   DROP COLUMN IF EXISTS claim_token,
--   DROP COLUMN IF EXISTS claim_expires_at;

ALTER TABLE public.synced_objects
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_synced_objects_batch(
  p_site_id uuid,
  p_object_type text,
  p_objects jsonb
)
RETURNS TABLE(external_id text, status text, claimed_token uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim_token uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.synced_objects (
    external_id,
    site_id,
    object_type,
    status,
    provider,
    metadata,
    first_seen_at,
    process_count
  )
  SELECT
    item->>'external_id',
    p_site_id,
    p_object_type,
    'pending',
    NULLIF(item->>'provider', ''),
    COALESCE(item->'metadata', '{}'::jsonb),
    timezone('utc', now()),
    0
  FROM jsonb_array_elements(COALESCE(p_objects, '[]'::jsonb)) AS item
  WHERE NULLIF(item->>'external_id', '') IS NOT NULL
  ON CONFLICT (external_id, site_id, object_type) DO NOTHING;

  RETURN QUERY
  UPDATE public.synced_objects AS synced
  SET
    status = 'processing',
    claim_token = v_claim_token,
    claim_expires_at = timezone('utc', now()) + interval '15 minutes',
    updated_at = timezone('utc', now())
  WHERE synced.site_id = p_site_id
    AND synced.object_type = p_object_type
    AND synced.status IN ('pending', 'error')
    AND synced.external_id IN (
      SELECT DISTINCT item->>'external_id'
      FROM jsonb_array_elements(COALESCE(p_objects, '[]'::jsonb)) AS item
    )
  RETURNING synced.external_id, synced.status, synced.claim_token;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_synced_objects_batch(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_synced_objects_batch(uuid, text, jsonb)
  TO service_role;
