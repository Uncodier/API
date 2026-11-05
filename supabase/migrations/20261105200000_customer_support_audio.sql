-- Deploy before enabling supportAudioContext, including existing tenant schemas.
-- Permanent admission receipts prevent repeat charges after crashes/timeouts.
-- Do not automatically delete/reclaim pending rows. Reconcile billing first.
DO $migration$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace
    WHERE (nspname = 'public' OR nspname LIKE 'app\_%' ESCAPE '\')
      AND to_regclass(format('%I.sites', nspname)) IS NOT NULL
  LOOP
    EXECUTE format('CREATE TABLE %I.customer_support_audio (
      site_id uuid NOT NULL REFERENCES %I.sites(id) ON DELETE CASCADE,
      source_hash text NOT NULL CHECK (source_hash ~ ''^[0-9a-f]{64}$''),
      status text NOT NULL CHECK (status IN (''pending'', ''complete'')),
      transcript text CHECK (length(transcript) <= 12000),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (site_id, source_hash),
      CHECK (status <> ''complete'' OR (transcript IS NOT NULL AND length(transcript) > 0))
    )', s, s);
    EXECUTE format('ALTER TABLE %I.customer_support_audio ENABLE ROW LEVEL SECURITY', s);
    -- GRANT is additive: remove default service_role DELETE/TRUNCATE privileges too.
    EXECUTE format('REVOKE ALL ON %I.customer_support_audio FROM PUBLIC, anon, authenticated, service_role', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.customer_support_audio TO service_role', s);
  END LOOP;
END
$migration$;
