-- Workflow robot mode: queryable triggers + run ledger + plan metadata.
-- Rollback:
--   ALTER TABLE public.instance_plans DROP COLUMN IF EXISTS metadata;
--   DROP TABLE IF EXISTS public.workflow_runs;
--   DROP TABLE IF EXISTS public.workflow_triggers;

ALTER TABLE public.instance_plans
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.workflow_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  template_plan_id uuid REFERENCES public.instance_plans(id) ON DELETE SET NULL,
  node_id uuid,
  kind text NOT NULL CHECK (kind IN ('cron', 'db_event', 'webhook', 'manual')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_triggers_site_kind_idx
  ON public.workflow_triggers (site_id, kind, enabled);
CREATE INDEX IF NOT EXISTS workflow_triggers_instance_idx
  ON public.workflow_triggers (instance_id);

CREATE TABLE IF NOT EXISTS public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  template_plan_id uuid REFERENCES public.instance_plans(id) ON DELETE SET NULL,
  run_plan_id uuid NOT NULL REFERENCES public.instance_plans(id) ON DELETE CASCADE,
  trigger_id uuid REFERENCES public.workflow_triggers(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  dry_run boolean NOT NULL DEFAULT false,
  idempotency_key text,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_idempotency_uidx
  ON public.workflow_runs (site_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_instance_idx
  ON public.workflow_runs (instance_id, created_at DESC);

ALTER TABLE public.workflow_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_triggers_service ON public.workflow_triggers;
CREATE POLICY workflow_triggers_service ON public.workflow_triggers
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS workflow_triggers_site_select ON public.workflow_triggers;
CREATE POLICY workflow_triggers_site_select ON public.workflow_triggers
  FOR SELECT
  USING (
    site_id IN (SELECT id FROM public.sites WHERE user_id = auth.uid())
    OR site_id IN (
      SELECT site_id FROM public.site_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS workflow_runs_service ON public.workflow_runs;
CREATE POLICY workflow_runs_service ON public.workflow_runs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS workflow_runs_site_select ON public.workflow_runs;
CREATE POLICY workflow_runs_site_select ON public.workflow_runs
  FOR SELECT
  USING (
    site_id IN (SELECT id FROM public.sites WHERE user_id = auth.uid())
    OR site_id IN (
      SELECT site_id FROM public.site_members WHERE user_id = auth.uid()
    )
  );
