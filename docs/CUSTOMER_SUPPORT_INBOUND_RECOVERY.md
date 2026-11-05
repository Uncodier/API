# Customer support inbound recovery

## Deployment

Apply `supabase/migrations/20261105193000_customer_support_inbound_commands.sql`
before deploying this API change. It provisions public and existing `app_*`
schemas containing commands. Include it when provisioning future tenant schemas.
Without the table, Zavu inbound command admission fails closed with HTTP 503.
No production migration or historical data repair is performed by the code change.

## Guarantees and scope

- Zavu inbound active-support requests use site + connection + origin message ID
  to claim command creation once. Repeated requests poll the recorded command.
- An unbound receipt is ambiguous (the process may have submitted a command).
  It is never automatically expired or reclaimed. Reconcile with execution logs
  before binding its verified command ID; do not delete it simply to retry.
- Failed commands stay associated with the event. Recovery of a terminal failed
  command requires explicit reconciliation, not automatic creation of a new command.
- Stable message primary keys recover concurrent/partial saves without overwriting
  delivery state. Existing inbound messages are reused by site/connection/provider ID.
- This is not a global exactly-once delivery guarantee. Other channels, historical
  assistant messages with random IDs, and disabled-agent handling retain their own
  behavior. Historical duplicate messages are not deleted or rewritten.
- Internal tool results and placeholder text cannot become assistant responses.
  Suppression flags are taken from the selected message, including nested wrappers;
  a true suppression flag cannot be overridden by a false conversation flag.

## Validation

Run `node node_modules/jest/bin/jest.js --config jest.support-response.config.js --runInBand`
and the existing command and workflow regression suites. Tests cover scoped command
reuse, uncertain binding, invalid output, nested flags, simultaneous message saves,
partial-save recovery and preservation of delivery metadata.