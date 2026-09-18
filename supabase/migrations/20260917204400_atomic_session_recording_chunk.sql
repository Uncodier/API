-- Rollback:
-- DROP FUNCTION IF EXISTS public.append_session_recording_chunk(
--   uuid, text, uuid, uuid, text, bigint, text, uuid, text, bigint, bigint, integer, jsonb
-- );

DROP FUNCTION IF EXISTS public.append_session_recording_chunk(
  uuid, text, uuid, uuid, text, bigint, text, bigint, bigint, integer, jsonb
);

CREATE OR REPLACE FUNCTION public.append_session_recording_chunk(
  p_event_id uuid,
  p_site_id text,
  p_visitor_id uuid,
  p_session_id uuid,
  p_url text,
  p_timestamp bigint,
  p_storage_path text,
  p_chunk_id uuid,
  p_content_hash text,
  p_start_timestamp bigint,
  p_end_timestamp bigint,
  p_event_count integer,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event_id uuid;
  v_site_id text;
  v_properties jsonb;
  v_chunks jsonb;
  v_chunk_manifest jsonb;
  v_existing_chunk jsonb;
  v_duration bigint;
  v_total_events bigint;
  v_start_time bigint;
BEGIN
  IF p_event_id IS NULL
    OR p_session_id IS NULL
    OR p_chunk_id IS NULL
    OR NULLIF(btrim(p_site_id), '') IS NULL
    OR NULLIF(btrim(p_storage_path), '') IS NULL
    OR NULLIF(btrim(p_content_hash), '') IS NULL
  THEN
    RAISE EXCEPTION 'Recording event, session, site, and storage path are required';
  END IF;
  IF p_event_count IS NULL OR p_event_count < 0 THEN
    RAISE EXCEPTION 'Recording event count must be non-negative';
  END IF;
  IF p_timestamp IS NULL
    OR p_start_timestamp IS NULL
    OR p_end_timestamp IS NULL
    OR p_end_timestamp < p_start_timestamp
  THEN
    RAISE EXCEPTION 'Valid recording timestamps are required';
  END IF;

  -- Serialize metadata writes for one recording without blocking other sessions.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_session_id::text, 0)
  );

  SELECT
    id,
    site_id,
    CASE
      WHEN jsonb_typeof(properties) = 'object' THEN properties
      ELSE '{}'::jsonb
    END
  INTO v_event_id, v_site_id, v_properties
  FROM public.session_events
  WHERE session_id = p_session_id
    AND event_type = 'session_recording'
  ORDER BY created_at ASC, id ASC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_site_id IS DISTINCT FROM p_site_id THEN
      RAISE EXCEPTION 'Recording session does not belong to site';
    END IF;

    v_chunks := CASE
      WHEN jsonb_typeof(v_properties->'chunks') = 'array'
        THEN v_properties->'chunks'
      ELSE '[]'::jsonb
    END;

    v_chunk_manifest := CASE
      WHEN jsonb_typeof(v_properties->'chunk_manifest') = 'object'
        THEN v_properties->'chunk_manifest'
      ELSE '{}'::jsonb
    END;
    v_existing_chunk := v_chunk_manifest->(p_chunk_id::text);

    IF v_existing_chunk IS NOT NULL THEN
      IF v_existing_chunk->>'path' IS DISTINCT FROM p_storage_path
        OR v_existing_chunk->>'content_hash' IS DISTINCT FROM p_content_hash
      THEN
        RAISE EXCEPTION 'Recording chunk identity conflicts with existing content';
      END IF;

      RETURN jsonb_build_object(
        'state', 'duplicate',
        'event_id', v_event_id
      );
    END IF;

    IF v_chunks ? p_storage_path THEN
      RETURN jsonb_build_object(
        'state', 'duplicate',
        'event_id', v_event_id
      );
    END IF;

    v_duration := CASE
      WHEN COALESCE(v_properties->>'duration', '') ~ '^[0-9]{1,19}$'
        THEN (v_properties->>'duration')::bigint
      ELSE 0
    END;
    v_total_events := CASE
      WHEN COALESCE(v_properties->>'total_events', '') ~ '^[0-9]{1,19}$'
        THEN (v_properties->>'total_events')::bigint
      ELSE 0
    END;
    v_start_time := CASE
      WHEN COALESCE(v_properties->>'start_time', '') ~ '^[0-9]{1,19}$'
        THEN (v_properties->>'start_time')::bigint
      ELSE p_start_timestamp
    END;

    UPDATE public.session_events
    SET
      timestamp = GREATEST(timestamp, p_timestamp),
      properties = v_properties || jsonb_build_object(
        'chunks', v_chunks || jsonb_build_array(p_storage_path),
        'chunk_manifest', v_chunk_manifest || jsonb_build_object(
          p_chunk_id::text,
          jsonb_build_object(
            'path', p_storage_path,
            'content_hash', p_content_hash
          )
        ),
        'start_time', LEAST(v_start_time, p_start_timestamp),
        'end_time', GREATEST(
          COALESCE(
            CASE
              WHEN COALESCE(v_properties->>'end_time', '') ~ '^[0-9]{1,19}$'
                THEN (v_properties->>'end_time')::bigint
            END,
            p_end_timestamp
          ),
          p_end_timestamp
        ),
        'duration', v_duration + GREATEST(0, p_end_timestamp - p_start_timestamp),
        'total_events', v_total_events + p_event_count,
        'last_chunk_at', GREATEST(
          COALESCE(
            CASE
              WHEN COALESCE(v_properties->>'last_chunk_at', '') ~ '^[0-9]{1,19}$'
                THEN (v_properties->>'last_chunk_at')::bigint
            END,
            p_timestamp
          ),
          p_timestamp
        ),
        'metadata', CASE
          WHEN jsonb_typeof(v_properties->'metadata') = 'object'
            THEN v_properties->'metadata'
          ELSE '{}'::jsonb
        END || CASE
          WHEN jsonb_typeof(p_metadata) = 'object' THEN p_metadata
          ELSE '{}'::jsonb
        END
      ),
      updated_at = timezone('utc', now())
    WHERE id = v_event_id;

    RETURN jsonb_build_object('state', 'updated', 'event_id', v_event_id);
  END IF;

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
    p_event_id,
    p_site_id,
    p_visitor_id,
    p_session_id,
    'session_recording',
    p_url,
    p_timestamp,
    jsonb_build_object(
      'start_time', p_start_timestamp,
      'end_time', p_end_timestamp,
      'duration', GREATEST(0, p_end_timestamp - p_start_timestamp),
      'total_events', p_event_count,
      'chunks', jsonb_build_array(p_storage_path),
      'chunk_manifest', jsonb_build_object(
        p_chunk_id::text,
        jsonb_build_object(
          'path', p_storage_path,
          'content_hash', p_content_hash
        )
      ),
      'last_chunk_at', p_timestamp,
      'metadata', CASE
        WHEN jsonb_typeof(p_metadata) = 'object' THEN p_metadata
        ELSE '{}'::jsonb
      END
    )
  );

  RETURN jsonb_build_object('state', 'inserted', 'event_id', p_event_id);
END;
$$;

REVOKE ALL ON FUNCTION public.append_session_recording_chunk(
  uuid, text, uuid, uuid, text, bigint, text, uuid, text, bigint, bigint, integer, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_session_recording_chunk(
  uuid, text, uuid, uuid, text, bigint, text, uuid, text, bigint, bigint, integer, jsonb
) TO service_role;
