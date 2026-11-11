-- Deploy before the task create endpoint. Existing tasks remain untouched;
-- agents must look them up and UPDATE_TASK rather than creating a replacement.
DO $migration$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace
    WHERE (nspname = 'public' OR nspname LIKE 'app\_%' ESCAPE '\')
      AND to_regclass(format('%I.tasks', nspname)) IS NOT NULL
  LOOP
    EXECUTE format('ALTER TABLE %I.tasks ADD COLUMN IF NOT EXISTS creation_key text', s);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS tasks_creation_identity_unique
      ON %I.tasks (site_id, lead_id, creation_key) WHERE creation_key IS NOT NULL', s);
    -- Include closed tasks: retrying a completed operation must not reopen it.
    -- No new privileges or RLS exceptions are required.
  END LOOP;
END
$migration$;