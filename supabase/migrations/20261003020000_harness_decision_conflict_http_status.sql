-- Stale CAS tokens are an HTTP 409 business conflict, not a serialization failure.
-- PostgREST 14 can retry a manually raised 40001 indefinitely with the same tokens.
-- https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b
-- Preserve the deployed function, its ownership/ACLs, guards and existing receipts.
-- This migration does not terminate sessions. After applying it, an operator must
-- separately identify and stop any backends already trapped in the retry loop.
BEGIN;

DO $migration$
DECLARE
  v_function regprocedure := to_regprocedure(
    'public.record_harness_diagnostic_decision(uuid,uuid,uuid,bigint,timestamptz,uuid,text,text,text,jsonb)'
  );
  v_definition text;
  v_old_raise text := $old$RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'harness_decision_stale_state';$old$;
  v_new_raise text := $new$RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'harness_decision_stale_state';$new$;
  v_old_count integer;
  v_new_count integer;
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'Apply harness diagnostic decisions migration 20261001220000 first'
      USING ERRCODE = '42883';
  END IF;

  v_definition := pg_get_functiondef(v_function);
  v_old_count := (length(v_definition) - length(replace(v_definition, v_old_raise, ''))) / length(v_old_raise);
  v_new_count := (length(v_definition) - length(replace(v_definition, v_new_raise, ''))) / length(v_new_raise);

  -- Safe to reapply after this exact correction, but never silently skip drift.
  IF v_old_count = 0 AND v_new_count = 1 THEN
    RETURN;
  END IF;
  IF v_old_count <> 1 OR v_new_count <> 0 THEN
    RAISE EXCEPTION 'Unexpected harness diagnostic decision definition; inspect the stale-state guard before applying this migration';
  END IF;

  -- pg_get_functiondef emits CREATE OR REPLACE, retaining the function identity,
  -- owner, grants, SECURITY DEFINER, search_path, and every other body statement.
  EXECUTE replace(v_definition, v_old_raise, v_new_raise);
END;
$migration$;

COMMIT;
