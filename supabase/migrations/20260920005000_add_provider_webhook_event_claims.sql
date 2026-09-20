-- Rollback:
-- DROP FUNCTION IF EXISTS public.finish_provider_webhook_event(text, text, uuid, text, text);
-- DROP FUNCTION IF EXISTS public.claim_provider_webhook_event(text, text, text, uuid, integer);
-- DROP TABLE IF EXISTS private.provider_webhook_events;

CREATE UNIQUE INDEX IF NOT EXISTS payments_transaction_id_uidx
  ON public.payments (transaction_id);

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.provider_webhook_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('processing', 'completed', 'failed')),
  claim_token uuid,
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  claimed_at timestamp with time zone,
  claim_expires_at timestamp with time zone,
  completed_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (provider, event_id)
);

ALTER TABLE private.provider_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS provider_webhook_events_service_role
  ON private.provider_webhook_events;
CREATE POLICY provider_webhook_events_service_role
  ON private.provider_webhook_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE private.provider_webhook_events
  FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS provider_webhook_events_stale_claim_idx
  ON private.provider_webhook_events (claim_expires_at)
  WHERE status = 'processing';

CREATE OR REPLACE FUNCTION public.claim_provider_webhook_event(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_claim_token uuid,
  p_lease_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_expires_at timestamp with time zone;
  v_claim_expires_at timestamp with time zone;
  v_status text;
BEGIN
  IF p_provider IS NULL OR btrim(p_provider) = ''
    OR p_event_id IS NULL OR btrim(p_event_id) = ''
    OR p_event_type IS NULL OR btrim(p_event_type) = ''
    OR p_claim_token IS NULL
  THEN
    RAISE EXCEPTION 'Provider, event ID, event type, and claim token are required';
  END IF;
  IF p_lease_seconds IS NULL
    OR p_lease_seconds < 30
    OR p_lease_seconds > 3600
  THEN
    RAISE EXCEPTION 'Lease seconds must be between 30 and 3600';
  END IF;

  v_new_expires_at :=
    timezone('utc', now()) + make_interval(secs => p_lease_seconds);

  INSERT INTO private.provider_webhook_events (
    provider,
    event_id,
    event_type,
    status,
    claim_token,
    attempt_count,
    claimed_at,
    claim_expires_at
  )
  VALUES (
    p_provider,
    p_event_id,
    p_event_type,
    'processing',
    p_claim_token,
    1,
    timezone('utc', now()),
    v_new_expires_at
  )
  ON CONFLICT (provider, event_id) DO NOTHING
  RETURNING claim_expires_at INTO v_claim_expires_at;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'state', 'claimed',
      'claim_expires_at', v_claim_expires_at
    );
  END IF;

  UPDATE private.provider_webhook_events
  SET
    event_type = p_event_type,
    status = 'processing',
    claim_token = p_claim_token,
    attempt_count = attempt_count + 1,
    claimed_at = timezone('utc', now()),
    claim_expires_at = v_new_expires_at,
    completed_at = NULL,
    last_error = NULL,
    updated_at = timezone('utc', now())
  WHERE provider = p_provider
    AND event_id = p_event_id
    AND (
      status = 'failed'
      OR (
        status = 'processing'
        AND (
          claim_expires_at IS NULL
          OR claim_expires_at <= timezone('utc', now())
        )
      )
    )
  RETURNING claim_expires_at INTO v_claim_expires_at;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'state', 'claimed',
      'claim_expires_at', v_claim_expires_at
    );
  END IF;

  SELECT status
  INTO v_status
  FROM private.provider_webhook_events
  WHERE provider = p_provider
    AND event_id = p_event_id;

  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('state', 'completed');
  END IF;
  RETURN jsonb_build_object('state', 'busy');
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_provider_webhook_event(
  p_provider text,
  p_event_id text,
  p_claim_token uuid,
  p_status text,
  p_error_message text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'Invalid provider webhook terminal status';
  END IF;

  UPDATE private.provider_webhook_events
  SET
    status = p_status,
    claim_token = NULL,
    claim_expires_at = NULL,
    completed_at = CASE
      WHEN p_status = 'completed' THEN timezone('utc', now())
      ELSE NULL
    END,
    last_error = CASE
      WHEN p_status = 'failed' THEN left(p_error_message, 2000)
      ELSE NULL
    END,
    updated_at = timezone('utc', now())
  WHERE provider = p_provider
    AND event_id = p_event_id
    AND status = 'processing'
    AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_provider_webhook_event(text, text, text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_provider_webhook_event(text, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_provider_webhook_event(text, text, text, uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_provider_webhook_event(text, text, uuid, text, text)
  TO service_role;
