-- Rollback: DROP TABLE IF EXISTS public.appointments;
-- Team appointments are separate from catalog reservations and meeting tasks.
-- Both the scheduling tool and the Customer Support lead snapshot use this table.
CREATE TABLE IF NOT EXISTS public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  context_id uuid NOT NULL,
  title text NOT NULL,
  start_datetime timestamptz NOT NULL,
  end_datetime timestamptz NOT NULL,
  duration integer NOT NULL CHECK (duration >= 5),
  timezone text NOT NULL,
  participants text[] NOT NULL DEFAULT '{}',
  location text,
  description text,
  reminder jsonb,
  status text NOT NULL DEFAULT 'confirmed',
  calendar_link text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_valid_interval CHECK (end_datetime > start_datetime)
);

CREATE INDEX IF NOT EXISTS appointments_site_start_idx
  ON public.appointments (site_id, start_datetime);
CREATE INDEX IF NOT EXISTS appointments_context_site_start_idx
  ON public.appointments (context_id, site_id, start_datetime);

ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.appointments FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.appointments
  TO authenticated, service_role;

DROP POLICY IF EXISTS appointments_site_members ON public.appointments;
CREATE POLICY appointments_site_members ON public.appointments
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sites AS site
      WHERE site.id = appointments.site_id
        AND (
          site.user_id = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1 FROM public.site_members AS member
            WHERE member.site_id = site.id
              AND member.user_id = (SELECT auth.uid())
              AND member.status = 'active'
              AND member.restrict_to_assigned_only = false
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sites AS site
      WHERE site.id = appointments.site_id
        AND (
          site.user_id = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1 FROM public.site_members AS member
            WHERE member.site_id = site.id
              AND member.user_id = (SELECT auth.uid())
              AND member.status = 'active'
              AND member.restrict_to_assigned_only = false
          )
        )
    )
  );