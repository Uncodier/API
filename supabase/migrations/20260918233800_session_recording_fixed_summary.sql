-- Rollback:
-- Reapply public.append_session_recording_chunks(jsonb) from
-- 20260918233300_session_recording_chunk_batches.sql.
--
-- Chunk paths and manifests now live only in session_recording_chunks. The
-- canonical session_events row keeps bounded summary metadata so each append
-- does not rewrite an ever-growing JSONB value.

CREATE OR REPLACE FUNCTION public.append_session_recording_chunks(
  p_chunks jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_chunk jsonb;
  v_first_chunk jsonb;
  v_session_id uuid;
  v_recording_event_id uuid;
  v_site_id text;
  v_existing_site_id text;
  v_properties jsonb;
  v_chunk_id uuid;
  v_inserted_chunk_id uuid;
  v_existing_chunk_id uuid;
  v_existing_session_id uuid;
  v_storage_path text;
  v_content_hash text;
  v_existing_path text;
  v_existing_hash text;
  v_timestamp bigint;
  v_start_timestamp bigint;
  v_end_timestamp bigint;
  v_event_count integer;
  v_new_metadata jsonb;
  v_new_start bigint;
  v_new_end bigint;
  v_new_last_chunk bigint;
  v_new_event_count bigint;
  v_existing_start bigint;
  v_existing_end bigint;
  v_existing_event_count bigint;
  v_existing_last_chunk bigint;
  v_inserted_total integer := 0;
  v_duplicate_total integer := 0;
  v_inserted_for_session integer;
  v_event_ids jsonb := '{}'::jsonb;
BEGIN
  IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
    RAISE EXCEPTION 'Recording batch must be a JSON array';
  END IF;
  IF jsonb_array_length(p_chunks) < 1
    OR jsonb_array_length(p_chunks) > 10
  THEN
    RAISE EXCEPTION 'Recording batch must contain 1-10 chunks';
  END IF;

  FOR v_chunk IN
    SELECT value
    FROM jsonb_array_elements(p_chunks)
  LOOP
    IF jsonb_typeof(v_chunk) <> 'object'
      OR COALESCE(v_chunk->>'event_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR COALESCE(v_chunk->>'session_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR COALESCE(v_chunk->>'chunk_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR NULLIF(btrim(v_chunk->>'site_id'), '') IS NULL
      OR NULLIF(btrim(v_chunk->>'storage_path'), '') IS NULL
      OR NULLIF(btrim(v_chunk->>'content_hash'), '') IS NULL
      OR COALESCE(v_chunk->>'timestamp', '') !~ '^[0-9]{1,19}$'
      OR COALESCE(v_chunk->>'start_timestamp', '') !~ '^[0-9]{1,19}$'
      OR COALESCE(v_chunk->>'end_timestamp', '') !~ '^[0-9]{1,19}$'
      OR COALESCE(v_chunk->>'event_count', '') !~ '^[0-9]{1,9}$'
    THEN
      RAISE EXCEPTION 'Invalid recording chunk';
    END IF;

    IF NULLIF(v_chunk->>'visitor_id', '') IS NOT NULL
      AND (v_chunk->>'visitor_id')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION 'Invalid recording visitor';
    END IF;

    IF (v_chunk->>'end_timestamp')::bigint
      < (v_chunk->>'start_timestamp')::bigint
    THEN
      RAISE EXCEPTION 'Invalid recording timestamps';
    END IF;
  END LOOP;

  FOR v_session_id IN
    SELECT DISTINCT (value->>'session_id')::uuid
    FROM jsonb_array_elements(p_chunks)
    ORDER BY 1
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_session_id::text, 0)
    );

    SELECT value
    INTO v_first_chunk
    FROM jsonb_array_elements(p_chunks)
    WHERE (value->>'session_id')::uuid = v_session_id
    ORDER BY
      (value->>'timestamp')::bigint,
      (value->>'chunk_id')::uuid
    LIMIT 1;

    v_site_id := v_first_chunk->>'site_id';

    PERFORM 1
    FROM public.visitor_sessions
    WHERE id = v_session_id
      AND site_id::text = v_site_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Recording session does not belong to site';
    END IF;

    SELECT
      id,
      site_id,
      CASE
        WHEN jsonb_typeof(properties) = 'object' THEN properties
        ELSE '{}'::jsonb
      END
    INTO v_recording_event_id, v_existing_site_id, v_properties
    FROM public.session_events
    WHERE session_id = v_session_id
      AND event_type = 'session_recording'
    ORDER BY created_at, id
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.session_events (
        id,
        site_id,
        visitor_id,
        session_id,
        event_type,
        url,
        timestamp,
        properties
      )
      VALUES (
        (v_first_chunk->>'event_id')::uuid,
        v_site_id,
        NULLIF(v_first_chunk->>'visitor_id', '')::uuid,
        v_session_id,
        'session_recording',
        NULLIF(v_first_chunk->>'url', ''),
        (v_first_chunk->>'timestamp')::bigint,
        '{}'::jsonb
      )
      RETURNING id, site_id, properties
      INTO v_recording_event_id, v_existing_site_id, v_properties;
    END IF;

    IF v_existing_site_id IS DISTINCT FROM v_site_id THEN
      RAISE EXCEPTION 'Recording session does not belong to site';
    END IF;

    v_new_metadata := '{}'::jsonb;
    v_new_start := NULL;
    v_new_end := NULL;
    v_new_last_chunk := NULL;
    v_new_event_count := 0;
    v_inserted_for_session := 0;

    FOR v_chunk IN
      SELECT value
      FROM jsonb_array_elements(p_chunks)
      WHERE (value->>'session_id')::uuid = v_session_id
      ORDER BY
        (value->>'timestamp')::bigint,
        (value->>'chunk_id')::uuid
    LOOP
      IF v_chunk->>'site_id' IS DISTINCT FROM v_site_id THEN
        RAISE EXCEPTION 'Recording batch mixes sites for one session';
      END IF;

      v_chunk_id := (v_chunk->>'chunk_id')::uuid;
      v_storage_path := v_chunk->>'storage_path';
      v_content_hash := v_chunk->>'content_hash';
      v_timestamp := (v_chunk->>'timestamp')::bigint;
      v_start_timestamp := (v_chunk->>'start_timestamp')::bigint;
      v_end_timestamp := (v_chunk->>'end_timestamp')::bigint;
      v_event_count := (v_chunk->>'event_count')::integer;
      v_inserted_chunk_id := NULL;

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
      VALUES (
        v_chunk_id,
        v_recording_event_id,
        v_site_id,
        v_session_id,
        v_storage_path,
        v_content_hash,
        v_timestamp,
        v_start_timestamp,
        v_end_timestamp,
        v_event_count
      )
      ON CONFLICT DO NOTHING
      RETURNING chunk_id INTO v_inserted_chunk_id;

      IF v_inserted_chunk_id IS NULL THEN
        SELECT chunk_id, session_id, storage_path, content_hash
        INTO
          v_existing_chunk_id,
          v_existing_session_id,
          v_existing_path,
          v_existing_hash
        FROM public.session_recording_chunks
        WHERE chunk_id = v_chunk_id
          OR storage_path = v_storage_path
          OR (
            session_id = v_session_id
            AND content_hash = v_content_hash
          )
        ORDER BY
          (chunk_id = v_chunk_id) DESC,
          (storage_path = v_storage_path) DESC
        LIMIT 1;

        IF v_existing_session_id IS DISTINCT FROM v_session_id
          OR v_existing_hash IS DISTINCT FROM v_content_hash
          OR (
            v_existing_chunk_id = v_chunk_id
            AND v_existing_path IS DISTINCT FROM v_storage_path
          )
          OR (
            v_existing_path = v_storage_path
            AND v_existing_chunk_id IS DISTINCT FROM v_chunk_id
          )
        THEN
          RAISE EXCEPTION
            'Recording chunk identity conflicts with existing content';
        END IF;

        v_duplicate_total := v_duplicate_total + 1;
        CONTINUE;
      END IF;

      v_inserted_total := v_inserted_total + 1;
      v_inserted_for_session := v_inserted_for_session + 1;
      v_new_metadata := CASE
        WHEN jsonb_typeof(v_chunk->'metadata') = 'object'
          THEN jsonb_strip_nulls(jsonb_build_object(
            'device_type',
              CASE
                WHEN v_chunk->'metadata'->>'device_type'
                  IN ('desktop', 'tablet', 'mobile')
                  THEN v_chunk->'metadata'->>'device_type'
                ELSE NULL
              END,
            'screen_size',
              CASE
                WHEN COALESCE(v_chunk->'metadata'->>'screen_size', '')
                  ~ '^[0-9]{1,5}x[0-9]{1,5}$'
                  THEN v_chunk->'metadata'->>'screen_size'
                ELSE NULL
              END
          ))
        ELSE '{}'::jsonb
      END;
      v_new_start := CASE
        WHEN v_new_start IS NULL THEN v_start_timestamp
        ELSE LEAST(v_new_start, v_start_timestamp)
      END;
      v_new_end := CASE
        WHEN v_new_end IS NULL THEN v_end_timestamp
        ELSE GREATEST(v_new_end, v_end_timestamp)
      END;
      v_new_last_chunk := CASE
        WHEN v_new_last_chunk IS NULL THEN v_timestamp
        ELSE GREATEST(v_new_last_chunk, v_timestamp)
      END;
      v_new_event_count := v_new_event_count + v_event_count;
    END LOOP;

    IF v_inserted_for_session > 0 THEN
      v_existing_start := CASE
        WHEN COALESCE(v_properties->>'start_time', '') ~ '^[0-9]{1,19}$'
          THEN (v_properties->>'start_time')::bigint
        ELSE v_new_start
      END;
      v_existing_end := CASE
        WHEN COALESCE(v_properties->>'end_time', '') ~ '^[0-9]{1,19}$'
          THEN (v_properties->>'end_time')::bigint
        ELSE v_new_end
      END;
      v_existing_event_count := CASE
        WHEN COALESCE(v_properties->>'total_events', '') ~ '^[0-9]{1,19}$'
          THEN (v_properties->>'total_events')::bigint
        ELSE 0
      END;
      v_existing_last_chunk := CASE
        WHEN COALESCE(v_properties->>'last_chunk_at', '') ~ '^[0-9]{1,19}$'
          THEN (v_properties->>'last_chunk_at')::bigint
        ELSE v_new_last_chunk
      END;

      UPDATE public.session_events
      SET
        timestamp = GREATEST(timestamp, v_new_last_chunk),
        properties = (
          v_properties - 'chunks' - 'chunk_manifest'
        ) || jsonb_build_object(
          'start_time', LEAST(v_existing_start, v_new_start),
          'end_time', GREATEST(v_existing_end, v_new_end),
          'duration', GREATEST(
            0,
            GREATEST(v_existing_end, v_new_end)
              - LEAST(v_existing_start, v_new_start)
          ),
          'total_events', v_existing_event_count + v_new_event_count,
          'last_chunk_at', GREATEST(v_existing_last_chunk, v_new_last_chunk),
          'metadata', v_new_metadata
        ),
        updated_at = timezone('utc', now())
      WHERE id = v_recording_event_id;
    END IF;

    v_event_ids := v_event_ids || jsonb_build_object(
      v_session_id::text,
      v_recording_event_id
    );
  END LOOP;

  RETURN jsonb_build_object(
    'state', CASE WHEN v_inserted_total > 0 THEN 'updated' ELSE 'duplicate' END,
    'inserted_chunks', v_inserted_total,
    'duplicate_chunks', v_duplicate_total,
    'event_ids', v_event_ids
  );
END;
$$;

REVOKE ALL ON FUNCTION public.append_session_recording_chunks(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_session_recording_chunks(jsonb)
  TO service_role;
