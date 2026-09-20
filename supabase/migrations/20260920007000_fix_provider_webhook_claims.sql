-- Rollback:
-- DROP INDEX IF EXISTS public.payments_transaction_id_uidx;
-- CREATE UNIQUE INDEX payments_transaction_id_uidx
--   ON public.payments (transaction_id)
--   WHERE transaction_id IS NOT NULL;
-- Reapply the previous claim_provider_webhook_event function definition if needed.

-- A non-partial unique index is required so PostgREST upserts using
-- ON CONFLICT (transaction_id) can infer the conflict target.
DROP INDEX IF EXISTS public.payments_transaction_id_uidx;
CREATE UNIQUE INDEX payments_transaction_id_uidx
  ON public.payments (transaction_id);

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

REVOKE ALL ON FUNCTION public.claim_provider_webhook_event(text, text, text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_provider_webhook_event(text, text, text, uuid, integer)
  TO service_role;
