-- Rollback:
-- No safe rollback is available because seeded rows become the idempotency
-- ledger for recording retries. Dropping them can double-count old chunks.

-- Seed identities written by the legacy atomic RPC. Recording rows may still
-- be duplicated, so every chunk points at the oldest event for its session.
WITH canonical_recordings AS (
  SELECT DISTINCT ON (event.session_id)
    event.id,
    event.session_id,
    event.site_id
  FROM public.session_events AS event
  WHERE event.event_type = 'session_recording'
    AND event.session_id IS NOT NULL
  ORDER BY event.session_id, event.created_at, event.id
),
manifest_chunks AS (
  SELECT DISTINCT ON (manifest.key)
    manifest.key::uuid AS chunk_id,
    canonical.id AS recording_event_id,
    canonical.site_id,
    canonical.session_id,
    manifest.value->>'path' AS storage_path,
    manifest.value->>'content_hash' AS content_hash,
    CASE
      WHEN COALESCE(manifest.value->>'timestamp', '') ~ '^[0-9]{1,19}$'
        THEN (manifest.value->>'timestamp')::bigint
    END AS chunk_timestamp,
    CASE
      WHEN COALESCE(manifest.value->>'start_timestamp', '') ~ '^[0-9]{1,19}$'
        THEN (manifest.value->>'start_timestamp')::bigint
    END AS start_timestamp,
    CASE
      WHEN COALESCE(manifest.value->>'end_timestamp', '') ~ '^[0-9]{1,19}$'
        THEN (manifest.value->>'end_timestamp')::bigint
    END AS end_timestamp,
    CASE
      WHEN COALESCE(manifest.value->>'event_count', '') ~ '^[0-9]{1,9}$'
        THEN (manifest.value->>'event_count')::integer
    END AS event_count
  FROM canonical_recordings AS canonical
  JOIN public.session_events AS event
    ON event.session_id = canonical.session_id
    AND event.event_type = 'session_recording'
  CROSS JOIN LATERAL jsonb_each(
    CASE
      WHEN jsonb_typeof(event.properties->'chunk_manifest') = 'object'
        THEN event.properties->'chunk_manifest'
      ELSE '{}'::jsonb
    END
  ) AS manifest
  WHERE manifest.key
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND jsonb_typeof(manifest.value) = 'object'
    AND NULLIF(btrim(manifest.value->>'path'), '') IS NOT NULL
    AND NULLIF(btrim(manifest.value->>'content_hash'), '') IS NOT NULL
  ORDER BY manifest.key, event.created_at, event.id
)
INSERT INTO public.session_recording_chunks (
  chunk_id,
  recording_event_id,
  site_id,
  session_id,
  storage_path,
  content_hash,
  chunk_timestamp,
  start_timestamp,
  end_timestamp,
  event_count
)
SELECT
  chunk_id,
  recording_event_id,
  site_id,
  session_id,
  storage_path,
  content_hash,
  chunk_timestamp,
  start_timestamp,
  end_timestamp,
  event_count
FROM manifest_chunks
ON CONFLICT DO NOTHING;
