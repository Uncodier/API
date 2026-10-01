-- Durable, single-person email searches. Never expire/requeue a submitted job:
-- custom.externalId is correlation metadata, NOT a provider idempotency key.
CREATE TABLE public.icypeas_email_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE RESTRICT,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  firstname text NOT NULL DEFAULT '' CHECK (length(firstname) <= 200),
  lastname text NOT NULL DEFAULT '' CHECK (length(lastname) <= 200),
  domain_or_company text NOT NULL CHECK (length(domain_or_company) BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'ready' CHECK (
    state IN ('ready', 'submitting', 'unknown', 'pending', 'matched', 'no_match', 'failed')
  ),
  search_id text UNIQUE CHECK (search_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  status text NOT NULL DEFAULT 'READY',
  emails jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(emails) = 'array' AND jsonb_array_length(emails) <= 20
  ),
  error text,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  poll_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, input_hash),
  CHECK (firstname <> '' OR lastname <> ''),
  CHECK (state NOT IN ('ready', 'submitting', 'unknown') OR search_id IS NULL),
  CHECK (state NOT IN ('pending', 'matched', 'no_match') OR search_id IS NOT NULL),
  CHECK ((state = 'matched' AND jsonb_array_length(emails) > 0)
    OR (state <> 'matched' AND emails = '[]'::jsonb))
);

ALTER TABLE public.icypeas_email_searches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.icypeas_email_searches FROM PUBLIC, anon, authenticated, service_role;
-- No client policies; all access is site-scoped by the authenticated server.
-- Intentionally no DELETE/TRUNCATE grant, TTL, cancellation or reset path.
GRANT SELECT, INSERT, UPDATE ON TABLE public.icypeas_email_searches TO service_role;

CREATE FUNCTION public.guard_icypeas_email_search() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF ROW(NEW.id, NEW.site_id, NEW.input_hash, NEW.firstname, NEW.lastname, NEW.domain_or_company)
     IS DISTINCT FROM ROW(OLD.id, OLD.site_id, OLD.input_hash, OLD.firstname, OLD.lastname, OLD.domain_or_company) THEN
    RAISE EXCEPTION 'IcyPeas search identity is immutable';
  END IF;
  IF OLD.search_id IS NOT NULL AND NEW.search_id IS DISTINCT FROM OLD.search_id THEN
    RAISE EXCEPTION 'IcyPeas provider search ID is immutable';
  END IF;
  IF OLD.state IN ('matched', 'no_match', 'failed') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'IcyPeas terminal result is immutable';
  END IF;
  IF OLD.state <> 'ready' AND NEW.state = 'ready' THEN
    RAISE EXCEPTION 'IcyPeas submitted jobs cannot be reset';
  END IF;
  IF OLD.state <> 'ready' AND NEW.state = 'submitting' AND OLD.state <> 'submitting' THEN
    RAISE EXCEPTION 'IcyPeas jobs cannot be resubmitted';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_icypeas_email_search() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER guard_icypeas_email_search
  BEFORE UPDATE ON public.icypeas_email_searches
  FOR EACH ROW EXECUTE FUNCTION public.guard_icypeas_email_search();

COMMENT ON TABLE public.icypeas_email_searches IS
  'Service-only durable IcyPeas single searches; no automatic expiration/reset. Submitting/unknown require manual reconciliation, never resubmission.';