BEGIN;
SET LOCAL lock_timeout = '5s';

-- Backfill is opportunistic maintenance. Source-edit triggers keep their existing
-- synchronous semantics; only this entry point bounds downstream lock waits.
CREATE OR REPLACE FUNCTION public.backfill_catalog_search(p_after_id uuid, p_limit integer, p_site_id uuid)
RETURNS TABLE(catalog_item_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '50ms' AS $$
DECLARE v_id uuid; v_locked uuid; v_defer boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid backfill limit' USING ERRCODE = '22023';
  END IF;
  FOR v_id IN SELECT i.id FROM public.catalog_items i
    WHERE (p_after_id IS NULL OR i.id > p_after_id) AND (p_site_id IS NULL OR i.site_id = p_site_id)
    ORDER BY i.id LIMIT p_limit
  LOOP
    v_defer := false;
    -- All item writes/locks roll back together on contention, including a document
    -- refresh that succeeded before the embedding-job update encountered a lock.
    BEGIN
      SELECT i.id INTO v_locked FROM public.catalog_items i WHERE i.id = v_id FOR NO KEY UPDATE SKIP LOCKED;
      IF FOUND THEN
        PERFORM public.refresh_catalog_search_document(v_id);
        UPDATE public.catalog_embedding_jobs SET status = 'pending', attempts = 0,
          next_attempt_at = now(), last_error = NULL, updated_at = now()
          WHERE public.catalog_embedding_jobs.catalog_item_id = v_id AND status = 'exhausted';
      ELSE
        v_defer := true;
      END IF;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      v_defer := true;
    END;
    IF v_defer THEN
      -- This must commit before advancing the cursor. If enqueue fails, fail the
      -- whole RPC, never report success or retry a write with an unknown outcome.
      INSERT INTO public.catalog_search_refresh_events(catalog_item_id, revive_exhausted) VALUES (v_id, true);
    END IF;
    catalog_item_id := v_id;
    RETURN NEXT;
  END LOOP;
END $$;

-- Retain the established service-only maintenance entry point.
REVOKE ALL ON FUNCTION public.backfill_catalog_search(uuid, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backfill_catalog_search(uuid, integer, uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
