-- Bounded invoker reads: existing table grants and RLS remain authoritative.
CREATE INDEX IF NOT EXISTS assets_instance_created_id_idx
  ON public.assets (instance_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS assets_instance_image_created_id_idx
  ON public.assets (instance_id, created_at DESC, id DESC)
  WHERE file_type LIKE 'image/%';

CREATE OR REPLACE FUNCTION public.get_instance_asset_summaries(p_site_id uuid, p_instance_ids uuid[])
RETURNS TABLE(instance_id uuid, asset_count bigint, recent_assets jsonb, avatar_path text)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF p_site_id IS NULL OR p_instance_ids IS NULL OR cardinality(p_instance_ids) > 100 THEN
    RAISE EXCEPTION 'A site and at most 100 instance IDs are required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT i.id,
    (SELECT count(*) FROM public.assets a WHERE a.instance_id = i.id AND a.site_id = p_site_id),
    COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC, r.id DESC)
      FROM (SELECT a.id, a.file_path, a.name, a.file_type, a.created_at
        FROM public.assets a WHERE a.instance_id = i.id AND a.site_id = p_site_id
        ORDER BY a.created_at DESC, a.id DESC LIMIT 3) r), '[]'::jsonb),
    (SELECT a.file_path FROM public.assets a
      WHERE a.instance_id = i.id AND a.site_id = p_site_id AND a.file_type LIKE 'image/%'
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1)
  FROM public.remote_instances i
  WHERE i.site_id = p_site_id AND i.id = ANY(p_instance_ids);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_instance_asset_summaries(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_instance_asset_summaries(uuid, uuid[]) TO authenticated, service_role;