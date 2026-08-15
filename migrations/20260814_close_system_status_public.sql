-- Close system_status at the database: drop the anon-readable view and
-- keep base tables service_role only. Public reads go through
-- GET/POST /api/status/webhook and Realtime broadcast channel `system-status`.
--
-- Rollback:
--   Recreate the view only if you intentionally re-open direct PostgREST reads.
--   Do not GRANT SELECT on system_status / system_status_runs to anon.
--   DROP VIEW IF EXISTS public.system_status_public;

BEGIN;

DROP VIEW IF EXISTS public.system_status_public;

DO $$
BEGIN
  IF to_regclass('public.system_status_runs') IS NOT NULL THEN
    ALTER TABLE public.system_status_runs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.system_status_runs FORCE ROW LEVEL SECURITY;
    EXECUTE 'REVOKE ALL ON TABLE public.system_status_runs FROM anon, authenticated';
  END IF;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.system_status') IS NOT NULL THEN
    ALTER TABLE public.system_status ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.system_status FORCE ROW LEVEL SECURITY;
    EXECUTE 'REVOKE ALL ON TABLE public.system_status FROM anon, authenticated';
  END IF;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.system_status_runs') IS NOT NULL THEN
    DROP POLICY IF EXISTS "system_status_runs service only" ON public.system_status_runs;
    CREATE POLICY "system_status_runs service only"
      ON public.system_status_runs
      FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.system_status') IS NOT NULL THEN
    DROP POLICY IF EXISTS "system_status service only" ON public.system_status;
    CREATE POLICY "system_status service only"
      ON public.system_status
      FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END
$$;

-- Do not expose table changes on Realtime postgres_changes (public channel is broadcast only).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'system_status'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.system_status;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'system_status_runs'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.system_status_runs;
  END IF;
END
$$;

COMMIT;
