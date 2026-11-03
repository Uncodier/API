-- Widen only the active agent scheduler's date scope. Do not rewrite customer
-- timestamps or revive the retired candidate scheduler. The public wrapper still
-- drains trusted commands and rechecks economic pauses before admission.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  target regprocedure := to_regprocedure('public.claim_agent_requirement_run_before_commands(uuid[],integer,integer,uuid[])');
  definition text;
  old_scope text := $scope$q.created_at>='2026-09-01 00:00:00+00'::timestamptz
      AND q.updated_at>='2026-09-01 00:00:00+00'::timestamptz$scope$;
  new_scope text := $scope$(q.created_at>='2026-09-01 00:00:00+00'::timestamptz
      OR q.updated_at>='2026-09-01 00:00:00+00'::timestamptz)$scope$;
BEGIN
  IF target IS NULL THEN
    RAISE EXCEPTION 'Active agent requirement scheduler migration is required';
  END IF;
  definition := pg_get_functiondef(target);
  IF strpos(definition, new_scope)>0 AND strpos(definition, old_scope)=0 THEN
    RETURN; -- Exact repaired definition can be reapplied without changes.
  END IF;
  IF (length(definition)-length(replace(definition, old_scope, '')))/length(old_scope)<>1
    OR strpos(definition, new_scope)>0 THEN
    RAISE EXCEPTION 'Unexpected agent requirement date scope; review before migration';
  END IF;
  -- CREATE OR REPLACE preserves identity, owner, ACLs, SECURITY DEFINER,
  -- search_path, capacity, status/hold guards, budgets and execution leases.
  EXECUTE replace(definition, old_scope, new_scope);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
COMMIT;