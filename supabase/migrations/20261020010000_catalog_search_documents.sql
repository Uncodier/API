-- Shared catalog index. No catalog source rows are rewritten or backfilled here.
BEGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname IN ('vector', 'pg_trgm') AND n.nspname NOT IN ('public', 'extensions')) THEN
    RAISE EXCEPTION 'catalog search requires vector and pg_trgm in public or extensions';
  END IF;
END $$;
SET LOCAL search_path = public, extensions, pg_temp;

CREATE TABLE public.catalog_search_documents (
  catalog_item_id uuid PRIMARY KEY REFERENCES public.catalog_items(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  document_text text NOT NULL,
  name_text text NOT NULL,
  sku_text text NOT NULL,
  source_hash text NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  embedding vector(1536),
  embedding_model text,
  embedding_source_hash text,
  indexed_at timestamptz,
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', name_text), 'A') ||
    setweight(to_tsvector('simple', sku_text), 'A') ||
    setweight(to_tsvector('simple', document_text), 'B')
  ) STORED
);
CREATE INDEX catalog_search_documents_site_idx ON public.catalog_search_documents(site_id, catalog_item_id);
CREATE INDEX catalog_search_documents_fts_idx ON public.catalog_search_documents USING gin(search_tsv);
CREATE INDEX catalog_search_documents_trgm_idx ON public.catalog_search_documents USING gin(document_text gin_trgm_ops);
CREATE INDEX catalog_search_documents_name_idx ON public.catalog_search_documents(lower(name_text));
CREATE INDEX catalog_search_documents_sku_idx ON public.catalog_search_documents(lower(sku_text));
CREATE INDEX catalog_search_documents_vector_idx ON public.catalog_search_documents
  USING hnsw(embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND embedding_model = 'openai/text-embedding-3-small'
    AND embedding_source_hash = source_hash;

CREATE TABLE public.catalog_search_revisions (
  scope text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO public.catalog_search_revisions(scope) VALUES ('public');

-- One coalesced durable job per item. A new source generation revokes the old lease.
CREATE TABLE public.catalog_embedding_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id uuid NOT NULL UNIQUE REFERENCES public.catalog_search_documents(catalog_item_id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  source_hash text NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'retry', 'done', 'exhausted')),
  claim_token uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'leased') = (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX catalog_embedding_jobs_ready_idx ON public.catalog_embedding_jobs(next_attempt_at, id)
  WHERE status IN ('pending', 'retry');
CREATE INDEX catalog_embedding_jobs_expired_idx ON public.catalog_embedding_jobs(lease_expires_at, id)
  WHERE status = 'leased';

ALTER TABLE public.catalog_search_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_search_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_embedding_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_search_documents, public.catalog_search_revisions, public.catalog_embedding_jobs
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.catalog_search_revisions TO service_role;
GRANT SELECT ON public.catalog_embedding_jobs TO service_role;
CREATE POLICY catalog_search_revisions_service_read ON public.catalog_search_revisions
  FOR SELECT TO service_role USING (true);
CREATE POLICY catalog_embedding_jobs_service_read ON public.catalog_embedding_jobs
  FOR SELECT TO service_role USING (true);

CREATE FUNCTION public.catalog_search_bump_revision(p_site_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Always public first, then site, for consistent revision-row lock ordering.
  INSERT INTO public.catalog_search_revisions AS r(scope, revision) VALUES ('public', 1)
    ON CONFLICT (scope) DO UPDATE SET revision = r.revision + 1;
  IF p_site_id IS NOT NULL THEN
    INSERT INTO public.catalog_search_revisions AS r(scope, revision) VALUES (p_site_id::text, 1)
      ON CONFLICT (scope) DO UPDATE SET revision = r.revision + 1;
  END IF;
END $$;

-- Strict public-content projection. Never serialize a row, metadata, prices, or inventory.
CREATE FUNCTION public.catalog_search_document_text(p_item_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT left(btrim(regexp_replace(concat_ws(' ',
    'Name: ' || left(i.name, 1000), 'SKU: ' || left(i.sku, 250), 'Category: ' || left(c.name, 500),
    (SELECT string_agg(names.name, ' ' ORDER BY names.name COLLATE "C") FROM (
      SELECT DISTINCT left(s.name, 150) COLLATE "C" AS name
      FROM public.catalog_item_specs j JOIN public.item_specs s ON s.id = j.item_spec_id
      WHERE j.catalog_item_id = i.id AND s.site_id = i.site_id
      ORDER BY name LIMIT 20
    ) names),
    (SELECT string_agg(a.key || ' ' || left(i.metadata->'attributes'->>a.key, 200), ' ' ORDER BY a.key)
      FROM unnest(ARRAY['brand','material','dimensions','weight','warranty','duration',
        'level','language','format','license_type','color','size']) a(key)
      WHERE jsonb_typeof(i.metadata->'attributes'->a.key) = 'string'),
    'Description: ' || left(i.description, 6000)
  ), '[[:space:]]+', ' ', 'g')), 6000)
  FROM public.catalog_items i
  LEFT JOIN public.catalog_categories c ON c.id = i.category_id AND c.site_id = i.site_id
  WHERE i.id = p_item_id
$$;

CREATE FUNCTION public.refresh_catalog_search_document(p_item_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_item public.catalog_items%ROWTYPE;
  v_doc text;
  v_hash text;
  v_revision bigint;
BEGIN
  -- Serialize source-trigger and backfill refreshes without changing the original row.
  SELECT * INTO v_item FROM public.catalog_items WHERE id = p_item_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_doc := public.catalog_search_document_text(p_item_id);
  v_hash := encode(sha256(convert_to(v_doc, 'UTF8')), 'hex');
  INSERT INTO public.catalog_search_documents AS d
    (catalog_item_id, site_id, document_text, name_text, sku_text, source_hash, source_revision)
  VALUES (v_item.id, v_item.site_id, v_doc,
    btrim(regexp_replace(left(v_item.name, 1000), '[[:space:]]+', ' ', 'g')),
    btrim(regexp_replace(coalesce(left(v_item.sku, 250), ''), '[[:space:]]+', ' ', 'g')), v_hash, 1)
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

REVOKE ALL ON FUNCTION public.catalog_search_bump_revision(uuid),
  public.catalog_search_document_text(uuid), public.refresh_catalog_search_document(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMIT;