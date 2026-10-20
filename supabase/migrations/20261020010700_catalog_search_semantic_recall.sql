-- Forward-only semantic recall repair. Exact distance over eligible documents
-- avoids HNSW post-filter underfill; cost is linear in eligible vector count.
BEGIN;
SET LOCAL search_path = public, extensions, pg_temp;

DO $recall$
DECLARE
  v_function regprocedure;
  v_definition text;
  v_old text := $old$    RETURN QUERY SELECT ranked.catalog_item_id, ranked.site_id, (1 - ranked.distance)::double precision, ranked.exact
    FROM (
      SELECT d.catalog_item_id, d.site_id, d.embedding <=> p_embedding AS distance,
        ((md5(lower(d.name_text)) = md5(lower(v_query)) AND lower(d.name_text) = lower(v_query)) OR
         (md5(lower(d.sku_text)) = md5(lower(v_query)) AND lower(d.sku_text) = lower(v_query))) AS exact
      FROM public.catalog_search_documents d JOIN public.catalog_items i ON i.id = d.catalog_item_id AND i.site_id = d.site_id
      WHERE (p_site_id IS NULL OR d.site_id = p_site_id)
        AND d.embedding IS NOT NULL AND d.embedding_model = 'openai/text-embedding-3-small'
        AND d.embedding_source_hash = d.source_hash
        AND public.catalog_search_eligible(i, p_site_id, p_channel, p_filters)
      -- HNSW operator/order and validity predicate intentionally unchanged.
      ORDER BY d.embedding <=> p_embedding LIMIT least(p_limit * 4, 800)
    ) ranked WHERE 1 - ranked.distance >= p_min_similarity
    ORDER BY ranked.distance, ranked.catalog_item_id LIMIT p_limit;$old$;
  v_new text := $new$    RETURN QUERY WITH eligible AS MATERIALIZED (
      SELECT d.catalog_item_id, d.site_id, d.embedding,
        ((md5(lower(d.name_text)) = md5(lower(v_query)) AND lower(d.name_text) = lower(v_query)) OR
         (md5(lower(d.sku_text)) = md5(lower(v_query)) AND lower(d.sku_text) = lower(v_query))) AS exact
      FROM public.catalog_search_documents d JOIN public.catalog_items i ON i.id = d.catalog_item_id AND i.site_id = d.site_id
      WHERE (p_site_id IS NULL OR d.site_id = p_site_id)
        AND d.embedding IS NOT NULL AND d.embedding_model = 'openai/text-embedding-3-small'
        AND d.embedding_source_hash = d.source_hash
        AND public.catalog_search_eligible(i, p_site_id, p_channel, p_filters)
    ), ranked AS (
      -- The materialization fence prevents an ANN scan before live eligibility.
      -- Exact for scoped and global marketplace searches; no extension GUCs.
      SELECT e.catalog_item_id, e.site_id, e.embedding <=> p_embedding AS distance, e.exact
      FROM eligible e
      ORDER BY distance, e.catalog_item_id LIMIT p_limit
    )
    SELECT ranked.catalog_item_id, ranked.site_id, (1 - ranked.distance)::double precision, ranked.exact
    FROM ranked WHERE 1 - ranked.distance >= p_min_similarity
    ORDER BY ranked.distance, ranked.catalog_item_id;$new$;
  v_old_count integer;
  v_new_count integer;
BEGIN
  v_function := to_regprocedure('public.catalog_search_candidates(uuid,text,text,jsonb,text,vector,integer,double precision)');
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'Apply catalog search migrations through 10600 before 10700';
  END IF;
  v_definition := pg_get_functiondef(v_function);
  IF position('p_limit NOT BETWEEN 1 AND 201' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected catalog candidate limit guard; review before applying 10700';
  END IF;
  v_old_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
  v_new_count := (length(v_definition) - length(replace(v_definition, v_new, ''))) / length(v_new);
  IF v_old_count = 0 AND v_new_count = 1 THEN
    RETURN; -- Safe retry, but never silently accept an unknown retrieval body.
  END IF;
  IF v_old_count <> 1 OR v_new_count <> 0 THEN
    RAISE EXCEPTION 'Unexpected catalog semantic branch; review before applying 10700';
  END IF;
  -- Change only this unique semantic branch. Preserve lexical SQL, validation,
  -- signature/default 0.35, owner, ACLs, SECURITY DEFINER and fixed search_path.
  EXECUTE replace(v_definition, v_old, v_new);
END;
$recall$;

COMMIT;