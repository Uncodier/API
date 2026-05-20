-- System status tables for SLA monitoring and public /status page.
-- Rollback:
--   DROP VIEW IF EXISTS public.system_status_public;
--   DROP TABLE IF EXISTS public.system_status;
--   DROP TABLE IF EXISTS public.system_status_runs;

BEGIN;

CREATE TABLE IF NOT EXISTS public.system_status_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL CHECK (trigger IN ('github_push', 'cron_hourly', 'manual')),
  environment text,
  overall_status text NOT NULL CHECK (overall_status IN ('healthy', 'degraded', 'down')),
  sla_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  checks_passed int NOT NULL DEFAULT 0,
  checks_failed int NOT NULL DEFAULT 0,
  checks_degraded int NOT NULL DEFAULT 0,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_status_runs_created_at
  ON public.system_status_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS public.system_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.system_status_runs(id) ON DELETE CASCADE,
  trigger text NOT NULL,
  system_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('up', 'degraded', 'down', 'skipped')),
  summary text,
  probe_path text,
  http_status int,
  latency_ms int NOT NULL DEFAULT 0,
  error_message text,
  health_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_status_run_id ON public.system_status (run_id);
CREATE INDEX IF NOT EXISTS idx_system_status_system_created
  ON public.system_status (system_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_status_created_at ON public.system_status (created_at DESC);

ALTER TABLE public.system_status_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_status_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.system_status FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE public.system_status_runs FROM anon, authenticated';
  EXECUTE 'REVOKE ALL ON TABLE public.system_status FROM anon, authenticated';
END
$$;

DROP POLICY IF EXISTS "system_status_runs service only" ON public.system_status_runs;
CREATE POLICY "system_status_runs service only"
  ON public.system_status_runs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "system_status service only" ON public.system_status;
CREATE POLICY "system_status service only"
  ON public.system_status
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Public read view (sanitized columns only; health_payload should already be sanitized by app)
CREATE OR REPLACE VIEW public.system_status_public AS
SELECT
  s.id,
  s.run_id,
  s.system_key,
  s.status,
  s.summary,
  s.latency_ms,
  s.health_payload,
  s.created_at,
  r.overall_status AS run_overall_status,
  r.trigger AS run_trigger
FROM public.system_status s
JOIN public.system_status_runs r ON r.id = s.run_id;

GRANT SELECT ON public.system_status_public TO anon, authenticated;

COMMIT;
