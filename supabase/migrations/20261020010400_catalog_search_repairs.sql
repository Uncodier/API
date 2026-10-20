-- Forward-only repair: never serialize source transactions on a revision hot row.
BEGIN;
SET LOCAL search_path = public, extensions, pg_temp;

CREATE TABLE public.catalog_search_revision_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_search_revision_events_site_idx
  ON public.catalog_search_revision_events(site_id, id);
ALTER TABLE public.catalog_search_revision_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_search_revision_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.catalog_search_revision_events_id_seq FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.catalog_search_bump_revision(p_site_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO public.catalog_search_revision_events(site_id) VALUES (p_site_id)
$$;

-- Sequences are NOT commit ordered. COUNT detects a late commit below visible MAX.
-- Events must never be deleted: retention/compaction needs a separate future protocol.
CREATE FUNCTION public.catalog_search_revision(p_site_id uuid DEFAULT NULL) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT 'events-v1:' || count(*)::text || ':' || coalesce(max(e.id), 0)::text
  FROM public.catalog_search_revision_events e
  WHERE p_site_id IS NULL OR e.site_id = p_site_id
$$;
COMMENT ON TABLE public.catalog_search_revisions IS
  'Deprecated by 20261020010400; no longer updated. Read catalog_search_revision(uuid) instead.';
REVOKE SELECT ON public.catalog_search_revisions FROM service_role;

-- Append-only requests avoid FK/source locks and coalescing-row inversions in
-- category/spec fanout. Unlike revision events these requests are deleted on drain.
CREATE TABLE public.catalog_search_refresh_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catalog_item_id uuid NOT NULL,
  revive_exhausted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.catalog_search_refresh_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_search_refresh_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.catalog_search_refresh_events_id_seq FROM PUBLIC, anon, authenticated, service_role;

DROP INDEX public.catalog_search_documents_name_idx;
DROP INDEX public.catalog_search_documents_sku_idx;
CREATE INDEX catalog_search_documents_name_idx ON public.catalog_search_documents(md5(lower(name_text)));
CREATE INDEX catalog_search_documents_sku_idx ON public.catalog_search_documents(md5(lower(sku_text)));

CREATE OR REPLACE FUNCTION public.refresh_catalog_search_document(p_item_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_item public.catalog_items%ROWTYPE;
  v_doc text; v_name text; v_sku text; v_hash text; v_revision bigint;
BEGIN
  -- Backfill must not wait on a source row after already locking another item.
  SELECT * INTO v_item FROM public.catalog_items WHERE id = p_item_id FOR NO KEY UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.catalog_items WHERE id = p_item_id) THEN
      INSERT INTO public.catalog_search_refresh_events(catalog_item_id) VALUES (p_item_id);
    END IF;
    RETURN false;
  END IF;
  v_doc := public.catalog_search_document_text(p_item_id);
  -- Full lexical fields: hash indexes are byte-bounded even for multibyte names.
  v_name := btrim(regexp_replace(v_item.name, '[[:space:]]+', ' ', 'g'));
  v_sku := btrim(regexp_replace(coalesce(v_item.sku, ''), '[[:space:]]+', ' ', 'g'));
  -- Structured retrieval identity prevents ambiguous labeled semantic documents
  -- from hiding a lexical edit. Lexical-only edits may harmlessly re-embed.
  v_hash := encode(sha256(convert_to(jsonb_build_array('source-v2-byte7000', v_name, v_sku, v_doc)::text, 'UTF8')), 'hex');
  INSERT INTO public.catalog_search_documents AS d
    (catalog_item_id, site_id, document_text, name_text, sku_text, source_hash, source_revision)
  VALUES (v_item.id, v_item.site_id, v_doc, v_name, v_sku, v_hash, 1)
  ON CONFLICT (catalog_item_id) DO UPDATE SET
    site_id = EXCLUDED.site_id, document_text = EXCLUDED.document_text,
    name_text = EXCLUDED.name_text, sku_text = EXCLUDED.sku_text,
    source_hash = EXCLUDED.source_hash, source_revision = d.source_revision + 1,
    embedding = NULL, embedding_model = NULL, embedding_source_hash = NULL, indexed_at = NULL
  WHERE d.source_hash IS DISTINCT FROM EXCLUDED.source_hash OR d.site_id IS DISTINCT FROM EXCLUDED.site_id
  RETURNING source_revision INTO v_revision;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.catalog_embedding_jobs AS j(catalog_item_id, site_id, source_hash, source_revision)
    VALUES (v_item.id, v_item.site_id, v_hash, v_revision)
  ON CONFLICT (catalog_item_id) DO UPDATE SET site_id = EXCLUDED.site_id,
    source_hash = EXCLUDED.source_hash, source_revision = EXCLUDED.source_revision,
    status = 'pending', claim_token = NULL, lease_expires_at = NULL,
    attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now();
  PERFORM public.catalog_search_bump_revision(v_item.site_id);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.catalog_search_relationship_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_old jsonb; v_new jsonb; v_site uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'catalog_item_specs' THEN
    INSERT INTO public.catalog_search_refresh_events(catalog_item_id)
      SELECT DISTINCT x FROM unnest(ARRAY[(v_old->>'catalog_item_id')::uuid,
        (v_new->>'catalog_item_id')::uuid]) x WHERE x IS NOT NULL;
    -- Links have no site_id. Invalidate the actual old/new item sites immediately.
    FOR v_site IN SELECT DISTINCT i.site_id FROM public.catalog_items i
      WHERE i.id IN ((v_old->>'catalog_item_id')::uuid, (v_new->>'catalog_item_id')::uuid)
    LOOP PERFORM public.catalog_search_bump_revision(v_site); END LOOP;
  ELSIF TG_TABLE_NAME = 'catalog_categories' THEN
    INSERT INTO public.catalog_search_refresh_events(catalog_item_id)
      SELECT i.id FROM public.catalog_items i
      WHERE i.category_id IN ((v_old->>'id')::uuid, (v_new->>'id')::uuid);
  ELSIF TG_TABLE_NAME = 'item_specs' THEN
    INSERT INTO public.catalog_search_refresh_events(catalog_item_id)
      SELECT DISTINCT j.catalog_item_id FROM public.catalog_item_specs j
      WHERE j.item_spec_id IN ((v_old->>'id')::uuid, (v_new->>'id')::uuid);
  END IF;
  FOR v_site IN SELECT DISTINCT x FROM unnest(ARRAY[(v_old->>'site_id')::uuid,
    (v_new->>'site_id')::uuid]) x WHERE x IS NOT NULL
  LOOP PERFORM public.catalog_search_bump_revision(v_site); END LOOP;
  RETURN coalesce(NEW, OLD);
END $$;

CREATE FUNCTION public.catalog_search_drain_refresh_events(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_event record; v_locked uuid; v_count integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid refresh limit' USING ERRCODE = '22023';
  END IF;
  FOR v_event IN SELECT e.id, e.catalog_item_id, e.revive_exhausted FROM public.catalog_search_refresh_events e
    ORDER BY e.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    SELECT i.id INTO v_locked FROM public.catalog_items i WHERE i.id = v_event.catalog_item_id
      FOR NO KEY UPDATE SKIP LOCKED;
    IF NOT FOUND AND EXISTS (SELECT 1 FROM public.catalog_items WHERE id = v_event.catalog_item_id) THEN
      CONTINUE; -- Busy source: retain request, never wait while holding queue/item locks.
    END IF;
    IF v_locked IS NOT NULL THEN
      PERFORM public.refresh_catalog_search_document(v_event.catalog_item_id);
      IF v_event.revive_exhausted THEN
        UPDATE public.catalog_embedding_jobs SET status = 'pending', attempts = 0,
          next_attempt_at = now(), last_error = NULL, updated_at = now()
          WHERE catalog_item_id = v_event.catalog_item_id AND status = 'exhausted';
      END IF;
    END IF;
    DELETE FROM public.catalog_search_refresh_events WHERE id = v_event.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.backfill_catalog_search(p_after_id uuid, p_limit integer, p_site_id uuid)
RETURNS TABLE(catalog_item_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid; v_locked uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid backfill limit' USING ERRCODE = '22023';
  END IF;
  FOR v_id IN SELECT i.id FROM public.catalog_items i
    WHERE (p_after_id IS NULL OR i.id > p_after_id) AND (p_site_id IS NULL OR i.site_id = p_site_id)
    ORDER BY i.id LIMIT p_limit
  LOOP
    SELECT i.id INTO v_locked FROM public.catalog_items i WHERE i.id = v_id FOR NO KEY UPDATE SKIP LOCKED;
    IF FOUND THEN
      PERFORM public.refresh_catalog_search_document(v_id);
      UPDATE public.catalog_embedding_jobs SET status = 'pending', attempts = 0,
        next_attempt_at = now(), last_error = NULL, updated_at = now()
        WHERE public.catalog_embedding_jobs.catalog_item_id = v_id AND status = 'exhausted';
    ELSE
      -- Advancing the cursor remains safe; the deferred item is durable.
      INSERT INTO public.catalog_search_refresh_events(catalog_item_id, revive_exhausted) VALUES (v_id, true);
    END IF;
    catalog_item_id := v_id;
    RETURN NEXT;
  END LOOP;
END $$;

-- Existing worker contract remains unchanged; every polling call drains bounded
-- lexical refresh work even when no embedding job was previously ready.
CREATE FUNCTION public.catalog_search_refresh_batch(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid refresh batch limit' USING ERRCODE = '22023';
  END IF;
  RETURN public.catalog_search_drain_refresh_events(p_limit);
END $$;

CREATE FUNCTION public.catalog_search_index_pending() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.catalog_search_refresh_events)
    OR EXISTS (SELECT 1 FROM public.catalog_embedding_jobs j WHERE j.attempts < 8
      AND ((j.status IN ('pending','retry') AND j.next_attempt_at <= statement_timestamp())
        OR (j.status = 'leased' AND j.lease_expires_at <= statement_timestamp())))
$$;

ALTER FUNCTION public.claim_catalog_embedding_jobs(integer, integer)
  RENAME TO catalog_search_claim_embedding_jobs;
REVOKE ALL ON FUNCTION public.catalog_search_claim_embedding_jobs(integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.claim_catalog_embedding_jobs(p_limit integer, p_lease_seconds integer)
RETURNS TABLE(id uuid, catalog_item_id uuid, site_id uuid, document_text text,
  source_hash text, source_revision bigint, claim_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'invalid claim bounds' USING ERRCODE = '22023';
  END IF;
  -- Independent of the provider claim size (API currently claims only eight).
  -- Non-semantic/sort-only fanout still makes bounded progress at 100 per poll.
  PERFORM public.catalog_search_drain_refresh_events(100);
  RETURN QUERY SELECT * FROM public.catalog_search_claim_embedding_jobs(p_limit, p_lease_seconds);
END $$;

CREATE OR REPLACE FUNCTION public.catalog_search_eligible(i public.catalog_items, p_site_id uuid,
  p_channel text, p_filters jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT (p_site_id IS NULL OR i.site_id = p_site_id)
    AND EXISTS (SELECT 1 FROM public.sites s WHERE s.id = i.site_id AND s.archived_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p_filters) f
      WHERE CASE WHEN f.key = 'kind' THEN NOT (
        (f.value = '"variant"'::jsonb AND i.parent_id IS NOT NULL) OR
        (f.value <> '"variant"'::jsonb AND to_jsonb(i)->'kind' = f.value
          AND (p_channel <> 'catalog' OR i.parent_id IS NULL)))
        WHEN f.key IN ('category_id','parent_id') AND f.value <> 'null'::jsonb
        THEN (to_jsonb(i)->>f.key)::uuid IS DISTINCT FROM (f.value #>> '{}')::uuid
        ELSE coalesce(to_jsonb(i)->f.key, 'null'::jsonb) IS DISTINCT FROM f.value END
    )
    AND CASE
      WHEN p_channel = 'catalog' THEN true
      WHEN p_channel = 'tools' THEN
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

-- Hash equality is only an index prefilter; full equality defeats MD5 collisions.
CREATE OR REPLACE FUNCTION public.catalog_search_candidates(p_site_id uuid, p_channel text,
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
    OR p_min_similarity NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'invalid candidate bounds' USING ERRCODE = '22023';
  END IF;
  v_query := btrim(regexp_replace(p_query, '[[:space:]]+', ' ', 'g'));
  IF v_query = '' THEN RETURN; END IF;
  IF p_mode = 'semantic' THEN
    IF p_embedding IS NULL OR vector_dims(p_embedding) <> 1536 OR (p_embedding <#> p_embedding) >= 0 THEN
      RAISE EXCEPTION 'expected nonzero 1536-dimensional query embedding' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT ranked.catalog_item_id, ranked.site_id, (1 - ranked.distance)::double precision, ranked.exact
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
    ORDER BY ranked.distance, ranked.catalog_item_id LIMIT p_limit;
  ELSE
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_tsquery := websearch_to_tsquery('simple', v_query);
    RETURN QUERY WITH searchable AS (
      SELECT d.catalog_item_id, d.site_id, d.name_text, d.sku_text, d.document_text, d.search_tsv
      FROM public.catalog_search_documents d
      UNION ALL
      SELECT i.id, i.site_id, i.name, coalesce(i.sku, ''),
        concat_ws(' ', i.name, i.sku, left(i.description, 6000)),
        setweight(to_tsvector('simple', coalesce(i.name, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(i.sku, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(left(i.description, 6000), '')), 'B')
      FROM public.catalog_items i
      WHERE NOT EXISTS (SELECT 1 FROM public.catalog_search_documents d WHERE d.catalog_item_id = i.id)
    ) SELECT d.catalog_item_id, d.site_id,
      (CASE WHEN md5(lower(d.sku_text)) = md5(lower(v_query)) AND lower(d.sku_text) = lower(v_query) THEN 1000
        WHEN md5(lower(d.name_text)) = md5(lower(v_query)) AND lower(d.name_text) = lower(v_query) THEN 900 ELSE 0 END
        + 10 * ts_rank_cd(d.search_tsv, v_tsquery)
        + CASE WHEN d.document_text ILIKE v_pattern ESCAPE '\' THEN 2 ELSE 0 END
        + word_similarity(v_query, d.document_text))::double precision,
      ((md5(lower(d.name_text)) = md5(lower(v_query)) AND lower(d.name_text) = lower(v_query)) OR
       (md5(lower(d.sku_text)) = md5(lower(v_query)) AND lower(d.sku_text) = lower(v_query)))
    FROM searchable d JOIN public.catalog_items i ON i.id = d.catalog_item_id AND i.site_id = d.site_id
    WHERE (p_site_id IS NULL OR d.site_id = p_site_id)
      AND public.catalog_search_eligible(i, p_site_id, p_channel, p_filters)
      AND ((md5(lower(d.sku_text)) = md5(lower(v_query)) AND lower(d.sku_text) = lower(v_query)) OR
        (md5(lower(d.name_text)) = md5(lower(v_query)) AND lower(d.name_text) = lower(v_query))
        OR d.search_tsv @@ v_tsquery OR d.document_text ILIKE v_pattern ESCAPE '\'
        OR (length(v_query) >= 3 AND word_similarity(v_query, d.document_text) >= 0.5))
    ORDER BY 4 DESC, 3 DESC, d.catalog_item_id LIMIT p_limit;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.catalog_search_revision(uuid),
  public.catalog_search_refresh_batch(integer), public.catalog_search_index_pending(),
  public.catalog_search_drain_refresh_events(integer), public.claim_catalog_embedding_jobs(integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.catalog_search_revision(uuid),
  public.catalog_search_refresh_batch(integer), public.catalog_search_index_pending(),
  public.claim_catalog_embedding_jobs(integer, integer) TO service_role;
COMMIT;