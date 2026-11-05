-- Deploy before enabling inbound command dedup. No expiry/deletion/reclaim is
-- intentional: an unbound receipt may represent an already-submitted command.
-- Apply to existing app schemas as well as public; new tenant provisioning must
-- include this migration. Retain receipts for the provider's full retry lifetime.
DO $migration$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace
    WHERE (nspname = 'public' OR nspname LIKE 'app\_%' ESCAPE '\')
      AND to_regclass(format('%I.commands', nspname)) IS NOT NULL
  LOOP
    EXECUTE format('CREATE TABLE %I.customer_support_inbound_commands (
      site_id uuid NOT NULL,
      connection_id text NOT NULL CHECK (length(connection_id) > 0),
      origin_message_id text NOT NULL CHECK (length(origin_message_id) > 0),
      owner_token uuid NOT NULL,
      command_id uuid REFERENCES %I.commands(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (site_id, connection_id, origin_message_id)
    )', s, s);
    EXECUTE format('ALTER TABLE %I.customer_support_inbound_commands ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('REVOKE ALL ON %I.customer_support_inbound_commands FROM PUBLIC, anon, authenticated', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.customer_support_inbound_commands TO service_role', s);
  END LOOP;
END
$migration$;