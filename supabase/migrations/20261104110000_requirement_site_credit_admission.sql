-- Admission only: preserve the command/economic-recovery wrapper and all of the
-- active scheduler's scope, holds, ownership, capacity and recurring semantics.
-- No install-time data changes and no new billing renewal/debit side effects.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  target regprocedure := to_regprocedure('public.claim_agent_requirement_run_before_commands(uuid[],integer,integer,uuid[])');
  definition text;
  old_candidate text := $candidate$      AND q.site_id IS NOT NULL AND q.user_id IS NOT NULL$candidate$;
  new_candidate text := $candidate$      AND q.site_id IS NOT NULL AND q.user_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.sites admission_site
        WHERE admission_site.id=q.site_id AND admission_site.archived_at IS NULL)
      AND EXISTS (SELECT 1 FROM public.billing admission_billing
        WHERE admission_billing.site_id=q.site_id AND admission_billing.credits_available>0)$candidate$;
  old_recheck text := $recheck$    has_session:=FOUND;
    IF has_session AND (s.site_id<>r.site_id$recheck$;
  new_recheck text := $recheck$    has_session:=FOUND;
    -- The candidate snapshot can predate waits for mapping/session locks. Lock
    -- billing then site (the renewal lock order) and revalidate before any writes.
    -- Skip contended rows rather than blocking the global scheduler capacity lock.
    -- These are admission locks, not reservations: execution still checks billing.
    PERFORM 1 FROM public.billing admission_billing
      WHERE admission_billing.site_id=r.site_id AND admission_billing.credits_available>0
      FOR SHARE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    PERFORM 1 FROM public.sites admission_site
      WHERE admission_site.id=r.site_id AND admission_site.archived_at IS NULL
      FOR SHARE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF has_session AND (s.site_id<>r.site_id$recheck$;
BEGIN
  IF target IS NULL THEN
    RAISE EXCEPTION 'Active agent requirement scheduler migration is required';
  END IF;
  definition := pg_get_functiondef(target);
  IF strpos(definition, $scope$(q.created_at>='2026-09-01 00:00:00+00'::timestamptz
      OR q.updated_at>='2026-09-01 00:00:00+00'::timestamptz)$scope$)=0 THEN
    RAISE EXCEPTION 'Created-or-updated requirement scope migration is required';
  END IF;
  IF strpos(definition,new_candidate)>0 AND strpos(definition,new_recheck)>0 THEN
    RETURN; -- Exact installed guards can be reapplied safely.
  END IF;
  IF (length(definition)-length(replace(definition,old_candidate,'')))/length(old_candidate)<>1
    OR (length(definition)-length(replace(definition,old_recheck,'')))/length(old_recheck)<>1
    OR strpos(definition,'admission_site')>0 OR strpos(definition,'admission_billing')>0 THEN
    RAISE EXCEPTION 'Unexpected agent requirement admission definition; review before migration';
  END IF;
  -- CREATE OR REPLACE retains OID, owner, ACLs, SECURITY DEFINER and search_path.
  -- Zero/missing credit rows stay untouched and become eligible after recharge or
  -- the existing billing renewal path updates credits_available. Do not renew
  -- every candidate here or turn an admission skip into a durable execution hold.
  EXECUTE replace(replace(definition,old_candidate,new_candidate),old_recheck,new_recheck);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
COMMIT;