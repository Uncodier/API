-- Rollback:
-- Remove the `site_id` query parameter added by this migration from
-- backend.makinari.com prompt image URLs in public.catalog_items.

UPDATE public.catalog_items
SET
  image_url = image_url
    || CASE WHEN strpos(image_url, '?') > 0 THEN '&' ELSE '?' END
    || 'site_id='
    || site_id::text,
  updated_at = now()
WHERE site_id IS NOT NULL
  AND image_url LIKE 'https://backend.makinari.com/api/public/image/prompt/%'
  AND image_url !~ '(^|[?&])site_id=';
