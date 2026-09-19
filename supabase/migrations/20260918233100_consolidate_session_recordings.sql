-- Rollback:
-- DROP FUNCTION IF EXISTS public.consolidate_session_recording_duplicates(integer);
--
-- Run this function repeatedly after deployment until it returns
-- {"state":"complete"}. Each call merges a bounded number of rows so the
-- historical cleanup does not monopolize the database.

CREATE OR REPLACE FUNCTION public.consolidate_session_recording_duplicates(
  p_row_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_id uuid;
  v_canonical_id uuid;
  v_row_ids uuid[];
  v_deleted integer := 0;
  v_has_more boolean := false;
BEGIN
  IF p_row_limit < 1 OR p_row_limit > 500 THEN
    RAISE EXCEPTION 'Row limit must be between 1 and 500';
  END IF;

  SELECT event.session_id
  INTO v_session_id
  FROM public.session_events AS event
  WHERE event.event_type = 'session_recording'
    AND event.session_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.session_events AS duplicate
      WHERE duplicate.event_type = 'session_recording'
        AND duplicate.session_id = event.session_id
        AND duplicate.id <> event.id
    )
  ORDER BY event.session_id, event.created_at, event.id
  LIMIT 1;

  IF v_session_id IS NULL THEN
    RETURN jsonb_build_object('state', 'complete', 'merged_rows', 0);
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_session_id::text, 0)
  );

  SELECT array_agg(candidate.id ORDER BY candidate.created_at, candidate.id)
  INTO v_row_ids
  FROM (
    SELECT id, created_at
    FROM public.session_events
    WHERE event_type = 'session_recording'
      AND session_id = v_session_id
    ORDER BY created_at, id
    LIMIT p_row_limit + 1
    FOR UPDATE
  ) AS candidate;

  IF COALESCE(array_length(v_row_ids, 1), 0) < 2 THEN
    RETURN jsonb_build_object('state', 'retry', 'merged_rows', 0);
  END IF;
  v_canonical_id := v_row_ids[1];

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT manifest.key AS chunk_id
      FROM public.session_events AS event
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(event.properties->'chunk_manifest') = 'object'
            THEN event.properties->'chunk_manifest'
          ELSE '{}'::jsonb
        END
      ) AS manifest
      WHERE event.id = ANY(v_row_ids)
      GROUP BY manifest.key
      HAVING count(DISTINCT manifest.value) > 1
    ) AS conflicts
  ) THEN
    RAISE EXCEPTION
      'Cannot consolidate session % because chunk manifests conflict',
      v_session_id;
  END IF;

  WITH recording_rows AS (
    SELECT
      event.id,
      event.created_at,
      event.timestamp,
      CASE
        WHEN jsonb_typeof(event.properties) = 'object' THEN event.properties
        ELSE '{}'::jsonb
      END AS properties
    FROM public.session_events AS event
    WHERE event.id = ANY(v_row_ids)
  ),
  latest_metadata AS (
    SELECT
      CASE
        WHEN jsonb_typeof(properties->'metadata') = 'object'
          THEN properties->'metadata'
        ELSE '{}'::jsonb
      END AS metadata
    FROM recording_rows
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  ),
  recording_stats AS (
    SELECT
      min(
        CASE
          WHEN COALESCE(properties->>'start_time', '') ~ '^[0-9]{1,19}$'
            THEN (properties->>'start_time')::bigint
          ELSE timestamp
        END
      ) AS start_time,
      max(
        CASE
          WHEN COALESCE(properties->>'end_time', '') ~ '^[0-9]{1,19}$'
            THEN (properties->>'end_time')::bigint
          ELSE timestamp
        END
      ) AS end_time,
      max(
        CASE
          WHEN COALESCE(properties->>'last_chunk_at', '') ~ '^[0-9]{1,19}$'
            THEN (properties->>'last_chunk_at')::bigint
          ELSE timestamp
        END
      ) AS last_chunk_at,
      max(timestamp) AS event_timestamp,
      sum(
        CASE
          WHEN COALESCE(properties->>'total_events', '') ~ '^[0-9]{1,19}$'
            THEN (properties->>'total_events')::bigint
          ELSE 0
        END
      ) AS total_events
    FROM recording_rows
  ),
  path_values AS (
    SELECT
      source.path,
      min(source.created_at) AS first_seen
    FROM (
      SELECT row.created_at, chunk_path.value AS path
      FROM recording_rows AS row
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(row.properties->'chunks') = 'array'
            THEN row.properties->'chunks'
          ELSE '[]'::jsonb
        END
      ) AS chunk_path
      UNION ALL
      SELECT row.created_at, manifest.value->>'path' AS path
      FROM recording_rows AS row
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(row.properties->'chunk_manifest') = 'object'
            THEN row.properties->'chunk_manifest'
          ELSE '{}'::jsonb
        END
      ) AS manifest
    ) AS source
    WHERE source.path IS NOT NULL
      AND source.path <> ''
    GROUP BY source.path
  ),
  merged_paths AS (
    SELECT jsonb_agg(path ORDER BY first_seen, path) AS chunks
    FROM path_values
  ),
  manifest_values AS (
    SELECT DISTINCT ON (manifest.key)
      manifest.key AS chunk_id,
      manifest.value AS chunk_value
    FROM recording_rows AS row
    CROSS JOIN LATERAL jsonb_each(
      CASE
        WHEN jsonb_typeof(row.properties->'chunk_manifest') = 'object'
          THEN row.properties->'chunk_manifest'
        ELSE '{}'::jsonb
      END
    ) AS manifest
    ORDER BY manifest.key, row.created_at ASC, row.id ASC
  ),
  merged_manifest AS (
    SELECT jsonb_object_agg(chunk_id, chunk_value ORDER BY chunk_id)
      AS chunk_manifest
    FROM manifest_values
  )
  UPDATE public.session_events AS target
  SET
    timestamp = stats.event_timestamp,
    properties = (
      CASE
        WHEN jsonb_typeof(target.properties) = 'object' THEN target.properties
        ELSE '{}'::jsonb
      END
    ) || jsonb_build_object(
      'chunks', COALESCE(paths.chunks, '[]'::jsonb),
      'chunk_manifest', COALESCE(manifest.chunk_manifest, '{}'::jsonb),
      'start_time', stats.start_time,
      'end_time', stats.end_time,
      'duration', GREATEST(0, stats.end_time - stats.start_time),
      'total_events', stats.total_events,
      'last_chunk_at', stats.last_chunk_at,
      'metadata', metadata.metadata
    ),
    updated_at = timezone('utc', now())
  FROM recording_stats AS stats
  CROSS JOIN latest_metadata AS metadata
  CROSS JOIN merged_paths AS paths
  CROSS JOIN merged_manifest AS manifest
  WHERE target.id = v_canonical_id;

  DELETE FROM public.session_events
  WHERE id = ANY(v_row_ids)
    AND id <> v_canonical_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  SELECT EXISTS (
    SELECT 1
    FROM public.session_events
    WHERE event_type = 'session_recording'
      AND session_id = v_session_id
      AND id <> v_canonical_id
  )
  INTO v_has_more;

  RETURN jsonb_build_object(
    'state', CASE WHEN v_has_more THEN 'pending' ELSE 'session_complete' END,
    'session_id', v_session_id,
    'merged_rows', v_deleted,
    'has_more', v_has_more
  );
END;
$$;

REVOKE ALL ON FUNCTION public.consolidate_session_recording_duplicates(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consolidate_session_recording_duplicates(integer)
  TO service_role;
