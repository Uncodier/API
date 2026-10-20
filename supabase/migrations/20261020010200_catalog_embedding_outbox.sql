BEGIN;
SET LOCAL search_path = public, extensions, pg_temp;
CREATE FUNCTION public.claim_catalog_embedding_jobs(p_limit integer, p_lease_seconds integer)
RETURNS TABLE(id uuid, catalog_item_id uuid, site_id uuid, document_text text,
  source_hash text, source_revision bigint, claim_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'invalid claim bounds' USING ERRCODE = '22023';
  END IF;
  -- Crashed workers count toward the same finite retry budget as explicit failures.
  WITH exhausted AS (
    SELECT j.id FROM public.catalog_embedding_jobs j WHERE j.attempts >= 8
      AND ((j.status = 'leased' AND j.lease_expires_at <= clock_timestamp())
        OR j.status IN ('pending', 'retry'))
    ORDER BY j.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ) UPDATE public.catalog_embedding_jobs j SET status = 'exhausted', claim_token = NULL,
    lease_expires_at = NULL, last_error = 'attempts_exhausted', updated_at = now()
    FROM exhausted e WHERE j.id = e.id;
  RETURN QUERY WITH ready AS (
    SELECT j.id FROM public.catalog_embedding_jobs j
    WHERE j.attempts < 8 AND ((j.status IN ('pending', 'retry') AND j.next_attempt_at <= clock_timestamp())
      OR (j.status = 'leased' AND j.lease_expires_at <= clock_timestamp()))
    ORDER BY j.next_attempt_at, j.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.catalog_embedding_jobs j SET status = 'leased', claim_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      attempts = j.attempts + 1, updated_at = now()
    FROM ready r WHERE j.id = r.id RETURNING j.*
  )
  SELECT j.id, j.catalog_item_id, j.site_id, d.document_text, j.source_hash, j.source_revision, j.claim_token
  FROM claimed j JOIN public.catalog_search_documents d ON d.catalog_item_id = j.catalog_item_id
    AND d.source_hash = j.source_hash AND d.source_revision = j.source_revision;
END $$;

CREATE FUNCTION public.complete_catalog_embedding_job(p_job_id uuid, p_claim_token uuid,
  p_source_hash text, p_source_revision bigint, p_embedding vector(1536), p_model text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp AS $$
DECLARE v_job public.catalog_embedding_jobs%ROWTYPE; v_item uuid;
BEGIN
  IF p_embedding IS NULL OR vector_dims(p_embedding) <> 1536 OR p_model IS DISTINCT FROM 'openai/text-embedding-3-small'
    OR (p_embedding <#> p_embedding) >= 0 THEN
    RAISE EXCEPTION 'expected nonzero 1536-dimensional openai/text-embedding-3-small embedding' USING ERRCODE = '22023';
  END IF;
  SELECT j.catalog_item_id INTO v_item FROM public.catalog_embedding_jobs j WHERE j.id = p_job_id;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Same item -> document -> job order as refresh; do not lock job before source row.
  PERFORM 1 FROM public.catalog_items WHERE id = v_item FOR NO KEY UPDATE;
  SELECT * INTO v_job FROM public.catalog_embedding_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'leased' OR v_job.claim_token IS DISTINCT FROM p_claim_token
    OR v_job.lease_expires_at <= clock_timestamp() OR v_job.source_hash IS DISTINCT FROM p_source_hash
    OR v_job.source_revision IS DISTINCT FROM p_source_revision THEN RETURN false; END IF;
  UPDATE public.catalog_search_documents d SET embedding = p_embedding, embedding_model = p_model,
    embedding_source_hash = p_source_hash, indexed_at = now()
  WHERE d.catalog_item_id = v_job.catalog_item_id AND d.site_id = v_job.site_id
    AND d.source_hash = p_source_hash AND d.source_revision = p_source_revision;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.catalog_embedding_jobs SET status = 'done', claim_token = NULL,
    lease_expires_at = NULL, last_error = NULL, updated_at = now() WHERE id = p_job_id;
  PERFORM public.catalog_search_bump_revision(v_job.site_id);
  RETURN true;
END $$;

CREATE FUNCTION public.fail_catalog_embedding_job(p_job_id uuid, p_claim_token uuid, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE public.catalog_embedding_jobs j SET status = CASE WHEN j.attempts >= 8 THEN 'exhausted' ELSE 'retry' END,
    claim_token = NULL, lease_expires_at = NULL,
    next_attempt_at = clock_timestamp() + make_interval(secs => least(3600, 5 * power(2, least(j.attempts, 9)))::integer),
    -- Persist a controlled category only. Provider error bodies can contain secrets/documents.
    last_error = CASE WHEN p_error IN ('provider_error', 'rate_limited', 'invalid_embedding', 'timeout')
      THEN p_error ELSE 'embedding_failed' END, updated_at = now()
  WHERE j.id = p_job_id AND j.status = 'leased' AND j.claim_token = p_claim_token
    AND j.lease_expires_at > clock_timestamp();
  RETURN FOUND;
END $$;

CREATE FUNCTION public.backfill_catalog_search(p_after_id uuid, p_limit integer, p_site_id uuid)
RETURNS TABLE(catalog_item_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid backfill limit' USING ERRCODE = '22023';
  END IF;
  FOR v_id IN SELECT i.id FROM public.catalog_items i
    WHERE (p_after_id IS NULL OR i.id > p_after_id) AND (p_site_id IS NULL OR i.site_id = p_site_id)
    ORDER BY i.id LIMIT p_limit
  LOOP
    PERFORM public.refresh_catalog_search_document(v_id);
    -- Explicit repair/backfill revives exhausted jobs; ordinary queue polling never does.
    UPDATE public.catalog_embedding_jobs SET status = 'pending', attempts = 0,
      next_attempt_at = now(), last_error = NULL, updated_at = now()
      WHERE public.catalog_embedding_jobs.catalog_item_id = v_id AND status = 'exhausted';
    catalog_item_id := v_id;
    RETURN NEXT;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.claim_catalog_embedding_jobs(integer, integer),
  public.complete_catalog_embedding_job(uuid, uuid, text, bigint, vector, text),
  public.fail_catalog_embedding_job(uuid, uuid, text), public.backfill_catalog_search(uuid, integer, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_catalog_embedding_jobs(integer, integer),
  public.complete_catalog_embedding_job(uuid, uuid, text, bigint, vector, text),
  public.fail_catalog_embedding_job(uuid, uuid, text), public.backfill_catalog_search(uuid, integer, uuid)
  TO service_role;
COMMIT;