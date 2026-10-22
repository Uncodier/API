BEGIN;
SET LOCAL lock_timeout = '5s';

-- Reserve BEFORE sending; a failure, timeout or unconfirmed provider response
-- never releases a reservation. Keep the legacy notification cooldown in the
-- caller BEFORE this RPC; this migration does not read or change notifications.
-- Commit the RPC transaction before any external send (PostgREST does this).
-- One permanent row per identity, not one row per attempt. No cascading site FK:
-- deleting/recreating a site must not erase its rolling admission reservation.
CREATE TABLE IF NOT EXISTS public.insufficient_credit_email_site_gates (
  site_id uuid PRIMARY KEY,
  last_attempt_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS public.insufficient_credit_email_recipient_gates (
  recipient_hash text PRIMARY KEY CHECK (
    length(recipient_hash) = 64 AND recipient_hash COLLATE "C" ~ '^[0-9a-f]{64}$'
  ),
  attempted_at timestamptz[] NOT NULL CHECK (
    cardinality(attempted_at) BETWEEN 1 AND 3
    AND array_ndims(attempted_at) = 1
    AND array_lower(attempted_at, 1) = 1
    AND array_position(attempted_at, NULL::timestamptz) IS NULL
  )
);

ALTER TABLE public.insufficient_credit_email_site_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insufficient_credit_email_site_gates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.insufficient_credit_email_recipient_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insufficient_credit_email_recipient_gates FORCE ROW LEVEL SECURITY;
-- Even BYPASSRLS service_role has no direct SELECT or mutation privileges.
-- The migration/function owner is the trusted database administrator.
REVOKE ALL ON TABLE public.insufficient_credit_email_site_gates,
  public.insufficient_credit_email_recipient_gates FROM PUBLIC, anon, authenticated, service_role;

-- Remove the earlier unbound overload on replay; it must not remain a bypass.
DROP FUNCTION IF EXISTS public.claim_insufficient_credit_email(uuid, text);
CREATE OR REPLACE FUNCTION public.claim_insufficient_credit_email(
  p_site_id uuid, p_recipient_hash text, p_owner_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now timestamptz;
  v_last_attempt_at timestamptz;
  v_attempted_at timestamptz[];
  v_idempotency_key text;
BEGIN
  IF p_site_id IS NULL OR p_recipient_hash IS NULL OR p_owner_id IS NULL
    OR length(p_recipient_hash) <> 64
    OR p_recipient_hash COLLATE "C" !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_input');
  END IF;

  -- Fixed, disjoint two-int advisory-lock namespaces avoid site/recipient lock
  -- inversion even if hashtext collides. Collisions only over-serialize callers.
  -- Every worker takes the site lock FIRST, then the recipient lock, including
  -- first attempts where no durable row exists yet. Locks last to xact commit.
  PERFORM pg_catalog.pg_advisory_xact_lock(1768121701, pg_catalog.hashtext(p_site_id::text));
  PERFORM pg_catalog.pg_advisory_xact_lock(1768121702, pg_catalog.hashtext(p_recipient_hash));

  -- Bind the owner captured by the caller before resolving its recipient email.
  -- A transfer between that read and claim must not notify the previous owner.
  -- Keep the active owned site stable through commit (including archival/deletion).
  PERFORM 1 FROM public.sites
    WHERE id = p_site_id AND archived_at IS NULL AND user_id = p_owner_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'site_unavailable');
  END IF;
  -- now()/transaction_timestamp() can predate time spent waiting on another
  -- worker. Evaluate rolling windows using wall-clock time AFTER all locks.
  v_now := pg_catalog.clock_timestamp();

  SELECT last_attempt_at INTO v_last_attempt_at
    FROM public.insufficient_credit_email_site_gates WHERE site_id = p_site_id;
  IF v_last_attempt_at > v_now - interval '24 hours' THEN
    -- Same-site duplicates do not reveal the prior key or consume any budget,
    -- even when the caller supplies a different valid recipient hash.
    RETURN jsonb_build_object('acquired', false, 'reason', 'site_rate_limited');
  END IF;

  SELECT attempted_at INTO v_attempted_at
    FROM public.insufficient_credit_email_recipient_gates WHERE recipient_hash = p_recipient_hash;
  SELECT coalesce(array_agg(attempt_at ORDER BY attempt_at), ARRAY[]::timestamptz[])
    INTO v_attempted_at FROM unnest(v_attempted_at) AS attempts(attempt_at)
    WHERE attempt_at > v_now - interval '10 minutes';
  IF cardinality(v_attempted_at) >= 3 THEN
    -- No inserts, updates or even pruning for a denied claim.
    RETURN jsonb_build_object('acquired', false, 'reason', 'recipient_rate_limited');
  END IF;

  v_idempotency_key := 'insufficient-credit-email:' || pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.insufficient_credit_email_site_gates(site_id, last_attempt_at, idempotency_key)
    VALUES (p_site_id, v_now, v_idempotency_key)
    ON CONFLICT (site_id) DO UPDATE
      SET last_attempt_at = EXCLUDED.last_attempt_at, idempotency_key = EXCLUDED.idempotency_key;
  INSERT INTO public.insufficient_credit_email_recipient_gates(recipient_hash, attempted_at)
    VALUES (p_recipient_hash, array_append(v_attempted_at, v_now))
    ON CONFLICT (recipient_hash) DO UPDATE SET attempted_at = EXCLUDED.attempted_at;

  RETURN jsonb_build_object('acquired', true, 'idempotency_key', v_idempotency_key);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_insufficient_credit_email(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_insufficient_credit_email(uuid, text, uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;