-- Rollback:
--   DROP TABLE IF EXISTS public.requirement_user_action_receipts;

CREATE TABLE IF NOT EXISTS public.requirement_user_action_receipts (
  requirement_id uuid NOT NULL
    REFERENCES public.requirements(id) ON DELETE CASCADE,
  action_id uuid NOT NULL
    REFERENCES public.instance_logs(id) ON DELETE CASCADE,
  action_created_at timestamptz NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  consumed_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (requirement_id, action_id),
  UNIQUE (requirement_id, revision)
);

ALTER TABLE public.requirement_user_action_receipts
  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS requirement_user_action_receipts_service_role
  ON public.requirement_user_action_receipts;
CREATE POLICY requirement_user_action_receipts_service_role
  ON public.requirement_user_action_receipts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.requirement_user_action_receipts
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.requirement_user_action_receipts
  TO service_role;
