-- Rollback requires restoring the previous implementation from
-- 20260917204400_atomic_session_recording_chunk.sql.

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
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'state', result->'state',
    'event_id', (result->'event_ids')->(p_session_id::text)
  )
  FROM (
    SELECT public.append_session_recording_chunks(
      jsonb_build_array(
        jsonb_build_object(
          'event_id', p_event_id,
          'site_id', p_site_id,
          'visitor_id', p_visitor_id,
          'session_id', p_session_id,
          'url', p_url,
          'timestamp', p_timestamp,
          'storage_path', p_storage_path,
          'chunk_id', p_chunk_id,
          'content_hash', p_content_hash,
          'start_timestamp', p_start_timestamp,
          'end_timestamp', p_end_timestamp,
          'event_count', p_event_count,
          'metadata', COALESCE(p_metadata, '{}'::jsonb)
        )
      )
    ) AS result
  ) AS batch;
$$;

REVOKE ALL ON FUNCTION public.append_session_recording_chunk(
  uuid, text, uuid, uuid, text, bigint, text, uuid, text, bigint, bigint, integer, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_session_recording_chunk(
  uuid, text, uuid, uuid, text, bigint, text, uuid, text, bigint, bigint, integer, jsonb
) TO service_role;
