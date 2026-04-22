-- Platform API tables.
-- Idempotent — safe to re-run.
--
-- Security model:
--   - These tables are backend-only. They are written and read exclusively
--     by the Uncodie API service-role client via `/api/platform/*` handlers.
--   - No anon, authenticated, or tenant JWT should ever touch them.
--   - RLS is therefore enabled and deny-all for public roles; service_role
--     bypasses RLS by default so the API keeps working without explicit
--     policies for it.
--
-- All tables carry `site_id` so they remain compatible with the standard
-- multi-tenant RLS pattern used elsewhere in the Uncodie DB if we ever
-- decide to expose a read-only endpoint to site owners.

BEGIN;

CREATE TABLE IF NOT EXISTS public.platform_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL,
  requirement_id UUID,
  api_key_id UUID,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status INT NOT NULL,
  scope TEXT,
  capability TEXT,
  cost_units INT NOT NULL DEFAULT 1,
  latency_ms INT NOT NULL DEFAULT 0,
  test_only BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  request_summary JSONB,
  response_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_audit_log_site_created_idx
  ON public.platform_audit_log (site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS platform_audit_log_requirement_idx
  ON public.platform_audit_log (requirement_id, created_at DESC)
  WHERE requirement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_audit_log_capability_idx
  ON public.platform_audit_log (capability, status, created_at DESC);


CREATE TABLE IF NOT EXISTS public.platform_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL,
  capability TEXT NOT NULL,
  period TEXT NOT NULL,        -- YYYY-MM-DD for daily buckets
  used INT NOT NULL DEFAULT 0,
  quota_override INT,          -- when null the runtime default applies
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_quotas_unique UNIQUE (site_id, capability, period)
);

CREATE INDEX IF NOT EXISTS platform_quotas_site_capability_idx
  ON public.platform_quotas (site_id, capability);


CREATE TABLE IF NOT EXISTS public.platform_tracking_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL,
  requirement_id UUID,
  event_name TEXT NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'platform-api',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_tracking_events_site_created_idx
  ON public.platform_tracking_events (site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS platform_tracking_events_requirement_idx
  ON public.platform_tracking_events (requirement_id, created_at DESC)
  WHERE requirement_id IS NOT NULL;


-- ─── Row Level Security — deny-all for public roles ───
-- service_role bypasses RLS automatically; these policies only lock out
-- `anon` and `authenticated` so a leaked anon key cannot read audit logs,
-- quotas or tracking events.

ALTER TABLE public.platform_audit_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_quotas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_tracking_events ENABLE ROW LEVEL SECURITY;

-- Optional hardening: also force RLS on the table owner so even the owning
-- role must go through a policy (service_role still bypasses globally).
ALTER TABLE public.platform_audit_log      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.platform_quotas         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.platform_tracking_events FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Revoke any grants accidentally inherited from `public` on these tables.
  EXECUTE 'REVOKE ALL ON TABLE public.platform_audit_log       FROM anon, authenticated';
  EXECUTE 'REVOKE ALL ON TABLE public.platform_quotas          FROM anon, authenticated';
  EXECUTE 'REVOKE ALL ON TABLE public.platform_tracking_events FROM anon, authenticated';
END
$$;

-- Explicit deny policies. Without any policy + RLS enabled, every query from
-- `anon`/`authenticated` is already rejected. We still add empty policies so
-- the Supabase advisor reports "RLS configured" and future maintainers see
-- the intent spelled out.
DROP POLICY IF EXISTS "platform_audit_log service only"       ON public.platform_audit_log;
CREATE POLICY "platform_audit_log service only"
  ON public.platform_audit_log
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "platform_quotas service only"          ON public.platform_quotas;
CREATE POLICY "platform_quotas service only"
  ON public.platform_quotas
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "platform_tracking_events service only" ON public.platform_tracking_events;
CREATE POLICY "platform_tracking_events service only"
  ON public.platform_tracking_events
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMIT;
