BEGIN;
SET LOCAL search_path = public, extensions, pg_temp;

CREATE FUNCTION public.catalog_search_validate(p_site_id uuid, p_channel text, p_filters jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_key text; v_value jsonb; v_text text;
BEGIN
  IF p_channel IS NULL OR p_channel NOT IN ('tools', 'shop', 'marketplace', 'catalog', 'pos')
    OR (p_site_id IS NULL AND p_channel <> 'marketplace') THEN
    RAISE EXCEPTION 'invalid search scope/channel' USING ERRCODE = '22023';
  END IF;
  IF p_filters IS NULL OR jsonb_typeof(p_filters) <> 'object' THEN
    RAISE EXCEPTION 'filters must be an object' USING ERRCODE = '22023';
  END IF;
  FOR v_key, v_value IN SELECT * FROM jsonb_each(p_filters) LOOP
    v_text := v_value #>> '{}';
    IF v_key NOT IN ('kind','digital_subtype','category_id','parent_id','status','availability_status',
      'currency','is_reservation','is_purchasable','is_recurring','is_pos_available','is_marketplace_listed') THEN
      RAISE EXCEPTION 'unsupported catalog filter' USING ERRCODE = '22023';
    END IF;
    IF v_key LIKE 'is\_%' ESCAPE '\' THEN
      IF jsonb_typeof(v_value) <> 'boolean' THEN
        RAISE EXCEPTION 'boolean filter required' USING ERRCODE = '22023';
      END IF;
    ELSIF v_key IN ('category_id', 'parent_id') THEN
      IF v_value <> 'null'::jsonb AND (jsonb_typeof(v_value) <> 'string' OR
        v_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN
        RAISE EXCEPTION 'UUID or null filter required' USING ERRCODE = '22023';
      END IF;
    ELSIF jsonb_typeof(v_value) <> 'string' OR length(v_text) NOT BETWEEN 1 AND 80 THEN
      RAISE EXCEPTION 'string filter required' USING ERRCODE = '22023';
    END IF;
    IF (v_key = 'kind' AND v_text NOT IN ('product', 'service', 'digital_asset', 'variant'))
      OR (v_key = 'status' AND v_text NOT IN ('active','archived'))
      OR (v_key = 'availability_status' AND v_text NOT IN ('available','unavailable','sold_out'))
      OR (v_key = 'currency' AND v_text !~ '^[A-Z]{3}$') THEN
      RAISE EXCEPTION 'invalid catalog filter value' USING ERRCODE = '22023';
    END IF;
  END LOOP;
END $$;

-- Private helper shared by retrieval and cache-hit revalidation. Authorization of
-- private site channels is the API's responsibility; clients have no EXECUTE grant.
CREATE FUNCTION public.catalog_search_eligible(i public.catalog_items, p_site_id uuid,
  p_channel text, p_filters jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT (p_site_id IS NULL OR i.site_id = p_site_id)
    AND EXISTS (SELECT 1 FROM public.sites s WHERE s.id = i.site_id AND s.archived_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p_filters) f
      WHERE CASE WHEN f.key = 'kind' THEN NOT (
        (f.value = '"variant"'::jsonb AND i.parent_id IS NOT NULL) OR
        (f.value <> '"variant"'::jsonb AND to_jsonb(i)->'kind' = f.value AND i.parent_id IS NULL))
        WHEN f.key IN ('category_id','parent_id') AND f.value <> 'null'::jsonb
        THEN (to_jsonb(i)->>f.key)::uuid IS DISTINCT FROM (f.value #>> '{}')::uuid
        ELSE coalesce(to_jsonb(i)->f.key, 'null'::jsonb) IS DISTINCT FROM f.value END
    )
    AND CASE
      WHEN p_channel = 'catalog' THEN true
      WHEN p_channel = 'tools' THEN
        -- Explicit administrative filters preserve the legacy tools contract.
        (p_filters ? 'status' OR p_filters ? 'availability_status') OR
        (i.status = 'active' AND i.availability_status = 'available' AND
          (i.parent_id IS NULL OR EXISTS (SELECT 1 FROM public.catalog_items p
            WHERE p.id = i.parent_id AND p.site_id = i.site_id
              AND p.status = 'active' AND p.availability_status = 'available')))
      WHEN p_channel IN ('shop','marketplace') THEN
        i.status = 'active' AND i.is_marketplace_listed IS TRUE AND i.parent_id IS NULL
        AND (i.availability_mode IS DISTINCT FROM 'manual' OR i.availability_status = 'available')
      WHEN p_channel = 'pos' THEN
        i.status = 'active' AND i.is_pos_available IS DISTINCT FROM false
        AND (i.availability_mode IS DISTINCT FROM 'manual' OR i.availability_status = 'available')
        AND (i.parent_id IS NULL OR EXISTS (SELECT 1 FROM public.catalog_items p
          WHERE p.id = i.parent_id AND p.site_id = i.site_id AND p.status = 'active'
            AND p.is_pos_available IS DISTINCT FROM false
            AND (p.availability_mode IS DISTINCT FROM 'manual' OR p.availability_status = 'available')))
      ELSE false
    END
$$;

CREATE FUNCTION public.catalog_search_visible_ids(p_ids uuid[], p_site_id uuid,
  p_channel text, p_filters jsonb)
RETURNS TABLE(id uuid, site_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM public.catalog_search_validate(p_site_id, p_channel, p_filters);
  IF p_ids IS NULL OR cardinality(p_ids) > 400 OR array_position(p_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid visible ID bounds' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT i.id, i.site_id FROM public.catalog_items i
    WHERE i.id = ANY(p_ids) AND public.catalog_search_eligible(i, p_site_id, p_channel, p_filters)
    ORDER BY i.id;
END $$;

CREATE FUNCTION public.catalog_search_candidates(p_site_id uuid, p_channel text,
  p_query text, p_filters jsonb, p_mode text, p_embedding vector(1536), p_limit integer,
  p_min_similarity double precision DEFAULT 0.35)
RETURNS TABLE(id uuid, site_id uuid, score double precision, exact_match boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE v_query text; v_pattern text; v_tsquery tsquery;
BEGIN
  PERFORM public.catalog_search_validate(p_site_id, p_channel, p_filters);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR p_mode IS NULL OR p_mode NOT IN ('text','semantic')
    OR p_query IS NULL OR length(p_query) > 1000 OR p_min_similarity IS NULL
    OR NOT (p_min_similarity BETWEEN 0 AND 1) THEN
    RAISE EXCEPTION 'invalid candidate bounds/mode/query' USING ERRCODE = '22023';
  END IF;
  v_query := btrim(regexp_replace(p_query, '[[:space:]]+', ' ', 'g'));
  IF v_query = '' THEN RETURN; END IF;
  IF p_mode = 'semantic' THEN
    IF p_embedding IS NULL OR vector_dims(p_embedding) <> 1536 OR (p_embedding <#> p_embedding) >= 0 THEN
      RAISE EXCEPTION 'semantic query requires a nonzero 1536-dimensional embedding' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT ranked.catalog_item_id, ranked.site_id, (1 - ranked.distance)::double precision, ranked.exact
    FROM (
      SELECT d.catalog_item_id, d.site_id, d.embedding <=> p_embedding AS distance,
        (lower(d.name_text) = lower(v_query) OR lower(d.sku_text) = lower(v_query)) AS exact
      FROM public.catalog_search_documents d JOIN public.catalog_items i ON i.id = d.catalog_item_id AND i.site_id = d.site_id
      WHERE (p_site_id IS NULL OR d.site_id = p_site_id)
        AND d.embedding IS NOT NULL AND d.embedding_model = 'openai/text-embedding-3-small'
        AND d.embedding_source_hash = d.source_hash
        AND public.catalog_search_eligible(i, p_site_id, p_channel, p_filters)
      -- Keep the inner ORDER BY as a naked distance operator for the HNSW path.
      ORDER BY d.embedding <=> p_embedding LIMIT least(p_limit * 4, 800)
    ) ranked WHERE 1 - ranked.distance >= p_min_similarity
    ORDER BY ranked.distance, ranked.catalog_item_id LIMIT p_limit;
  ELSE
    -- Escape LIKE metacharacters. Parameterized SQL alone does not make '%' literal.
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_tsquery := websearch_to_tsquery('simple', v_query);
    RETURN QUERY WITH searchable AS (
      SELECT d.catalog_item_id, d.site_id, d.name_text, d.sku_text, d.document_text, d.search_tsv
      FROM public.catalog_search_documents d
      UNION ALL
      -- Initial rollout is lexical immediately, even before the resumable backfill.
      -- Read only safe source fields, never a metadata serialization.
      SELECT i.id, i.site_id, i.name, coalesce(i.sku, ''),
        concat_ws(' ', i.name, i.sku, left(i.description, 6000)),
        setweight(to_tsvector('simple', coalesce(i.name, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(i.sku, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(left(i.description, 6000), '')), 'B')
      FROM public.catalog_items i
      WHERE NOT EXISTS (SELECT 1 FROM public.catalog_search_documents d WHERE d.catalog_item_id = i.id)
    ) SELECT d.catalog_item_id, d.site_id,
      (CASE WHEN lower(d.sku_text) = lower(v_query) THEN 1000
        WHEN lower(d.name_text) = lower(v_query) THEN 900 ELSE 0 END
        + 10 * ts_rank_cd(d.search_tsv, v_tsquery)
        + CASE WHEN d.document_text ILIKE v_pattern ESCAPE '\' THEN 2 ELSE 0 END
        + word_similarity(v_query, d.document_text))::double precision,
      (lower(d.name_text) = lower(v_query) OR lower(d.sku_text) = lower(v_query))
    FROM searchable d JOIN public.catalog_items i ON i.id = d.catalog_item_id AND i.site_id = d.site_id
    WHERE (p_site_id IS NULL OR d.site_id = p_site_id)
      AND public.catalog_search_eligible(i, p_site_id, p_channel, p_filters)
      AND (lower(d.sku_text) = lower(v_query) OR lower(d.name_text) = lower(v_query)
        OR d.search_tsv @@ v_tsquery OR d.document_text ILIKE v_pattern ESCAPE '\'
        OR (length(v_query) >= 3 AND word_similarity(v_query, d.document_text) >= 0.5))
    ORDER BY 4 DESC, 3 DESC, d.catalog_item_id LIMIT p_limit;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.catalog_search_validate(uuid, text, jsonb),
  public.catalog_search_eligible(public.catalog_items, uuid, text, jsonb),
  public.catalog_search_visible_ids(uuid[], uuid, text, jsonb),
  public.catalog_search_candidates(uuid, text, text, jsonb, text, vector, integer, double precision)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.catalog_search_visible_ids(uuid[], uuid, text, jsonb),
  public.catalog_search_candidates(uuid, text, text, jsonb, text, vector, integer, double precision) TO service_role;
COMMIT;