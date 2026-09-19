-- Rollback:
-- DROP FUNCTION IF EXISTS public.persist_tracking_event_batch(jsonb);

CREATE OR REPLACE FUNCTION public.persist_tracking_event_batch(
  p_events jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event jsonb;
  v_inserted integer := 0;
  v_total integer;
BEGIN
  IF p_events IS NULL OR pg_catalog.jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'Tracking batch must be a JSON array';
  END IF;

  v_total := pg_catalog.jsonb_array_length(p_events);
  IF v_total < 1 OR v_total > 100 THEN
    RAISE EXCEPTION 'Tracking batch must contain 1-100 events';
  END IF;

  FOR v_event IN
    SELECT value
    FROM pg_catalog.jsonb_array_elements(p_events)
  LOOP
    IF pg_catalog.jsonb_typeof(v_event) <> 'object'
      OR COALESCE(v_event->>'id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR COALESCE(v_event->>'site_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR NULLIF(pg_catalog.btrim(v_event->>'event_type'), '') IS NULL
      OR COALESCE(v_event->>'timestamp', '') !~ '^[0-9]{1,19}$'
    THEN
      RAISE EXCEPTION 'Invalid tracking event';
    END IF;

    IF NULLIF(v_event->>'visitor_id', '') IS NOT NULL
      AND (v_event->>'visitor_id')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION 'Invalid tracking visitor';
    END IF;

    IF NULLIF(v_event->>'session_id', '') IS NOT NULL
      AND (v_event->>'session_id')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION 'Invalid tracking session';
    END IF;

    IF NULLIF(v_event->>'segment_id', '') IS NOT NULL
      AND (v_event->>'segment_id')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION 'Invalid tracking segment';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_events) AS item(value)
    WHERE NULLIF(item.value->>'session_id', '') IS NOT NULL
    GROUP BY item.value->>'session_id'
    HAVING pg_catalog.count(DISTINCT item.value->>'site_id') > 1
      OR pg_catalog.count(
        DISTINCT NULLIF(item.value->>'visitor_id', '')
      ) > 1
  ) THEN
    RAISE EXCEPTION 'Tracking batch has conflicting session ownership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_events) AS item(value)
    JOIN public.visitor_sessions AS session
      ON session.id = NULLIF(item.value->>'session_id', '')::uuid
    WHERE session.site_id <> (item.value->>'site_id')::uuid
      OR (
        NULLIF(item.value->>'visitor_id', '') IS NOT NULL
        AND session.visitor_id
          <> NULLIF(item.value->>'visitor_id', '')::uuid
      )
  ) THEN
    RAISE EXCEPTION 'Tracking session ownership conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_events) AS item(
      id text,
      site_id text,
      event_type text,
      url text,
      visitor_id text,
      session_id text,
      "timestamp" bigint
    )
    JOIN public.session_events AS existing
      ON existing.id = item.id::uuid
    WHERE existing.site_id IS DISTINCT FROM item.site_id
      OR existing.event_type IS DISTINCT FROM item.event_type
      OR existing.url IS DISTINCT FROM item.url
      OR existing.visitor_id
        IS DISTINCT FROM NULLIF(item.visitor_id, '')::uuid
      OR existing.session_id
        IS DISTINCT FROM NULLIF(item.session_id, '')::uuid
      OR existing.timestamp IS DISTINCT FROM item."timestamp"
  ) THEN
    RAISE EXCEPTION 'Tracking event ID conflicts with existing event';
  END IF;

  INSERT INTO public.visitor_sessions (
    id,
    visitor_id,
    site_id,
    landing_url,
    current_url,
    referrer,
    started_at,
    last_activity_at,
    page_views,
    is_active
  )
  SELECT DISTINCT ON (session_id)
    session_id::uuid,
    visitor_id::uuid,
    site_id::uuid,
    url,
    url,
    referrer,
    item."timestamp",
    item."timestamp",
    1,
    true
  FROM pg_catalog.jsonb_to_recordset(p_events) AS item(
    session_id text,
    visitor_id text,
    site_id text,
    url text,
    referrer text,
    "timestamp" bigint
  )
  WHERE NULLIF(session_id, '') IS NOT NULL
    AND NULLIF(visitor_id, '') IS NOT NULL
  ORDER BY session_id, item."timestamp" ASC
  ON CONFLICT (id) DO NOTHING;

  WITH inserted AS (
    INSERT INTO public.session_events (
      id,
      site_id,
      event_type,
      event_name,
      url,
      referrer,
      visitor_id,
      session_id,
      segment_id,
      timestamp,
      properties,
      user_agent,
      ip,
      data
    )
    SELECT
      id::uuid,
      site_id,
      event_type,
      event_name,
      url,
      referrer,
      NULLIF(visitor_id, '')::uuid,
      NULLIF(session_id, '')::uuid,
      NULLIF(segment_id, '')::uuid,
      item."timestamp",
      COALESCE(properties, '{}'::jsonb),
      user_agent,
      ip,
      COALESCE(data, '{}'::jsonb)
    FROM pg_catalog.jsonb_to_recordset(p_events) AS item(
      id text,
      site_id text,
      event_type text,
      event_name text,
      url text,
      referrer text,
      visitor_id text,
      session_id text,
      segment_id text,
      "timestamp" bigint,
      properties jsonb,
      user_agent text,
      ip text,
      data jsonb
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer
  INTO v_inserted
  FROM inserted;

  RETURN pg_catalog.jsonb_build_object(
    'received', v_total,
    'inserted', v_inserted,
    'duplicates', v_total - v_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_tracking_event_batch(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_tracking_event_batch(jsonb)
  TO service_role;
