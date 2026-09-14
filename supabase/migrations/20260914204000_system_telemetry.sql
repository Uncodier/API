-- Rollback:
-- DROP TABLE IF EXISTS public.system_telemetry;

BEGIN;

CREATE TABLE IF NOT EXISTS public.system_telemetry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('up', 'degraded', 'down')),
  message text,
  latency_ms int DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_telemetry_system_created
  ON public.system_telemetry (system_key, created_at DESC);

ALTER TABLE public.system_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_telemetry FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE public.system_telemetry FROM anon, authenticated';
END
$$;

-- Allow only service_role to manage telemetry records
DROP POLICY IF EXISTS "system_telemetry service only" ON public.system_telemetry;
CREATE POLICY "system_telemetry service only"
  ON public.system_telemetry
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMIT;