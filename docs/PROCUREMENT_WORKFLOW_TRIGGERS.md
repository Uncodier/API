# Procurement workflow triggers

The API database-event allowlist and the market-fit workflow editor now include
suppliers, supplier contacts, catalog supplier links, requests, tenders,
publications, participants, event approvals, awards, purchase orders, receipts,
replenishment rules and replenishment cases. Subscriptions use existing
row-equality filters, scoped by `site_id`. The editor disables operations that
cannot occur: publications, awards, orders, receipts and catalog supplier links
are insert-only; suppliers are created/updated and archived rather than deleted.

## Rollout

Deploy both applications and apply, in timestamp order:

- `supabase/migrations/20261104100000_procurement_workflow_database_webhooks.sql`
- `supabase/migrations/20261104101000_procurement_workflow_confidentiality.sql`
- `supabase/migrations/20261104102000_workflow_database_webhook_event_identity.sql`

to the confirmed target environment through the approved migration process.
The migration requires the canonical market-fit procurement domain and
`public.dispatch_workflow_database_webhook()` from the API workflow webhook
migration. It aborts atomically if a required table or UUID `site_id` is missing.

The shared function uses Vault entries `workflow_webhook_url` and
`workflow_webhook_api_key`. The URL must target `/api/workflow/webhook`; the key
must match the server's `SERVICE_API_KEY`. Do not commit credential values.
No extra MCP-side dispatch is added, so writes from UI, MCP and other DB clients
share the same database event source.

In the workflow editor, select a Table trigger, choose a procurement table and
operations, save/sync the workflow, and enable the trigger. Existing procurement
tools remain responsible for authorized actions and mandatory human approvals.

## INSERT RETURNING correction

The forward-only API migration
`20261106110000_procurement_workflow_insert_returning.sql` corrects the
confidentiality guard installed above. PostgreSQL cannot see the candidate row
through the read RPC while checking `remote_instances INSERT ... RETURNING`.
The base-table restrictive policy now checks candidate-row membership and private
classification without requiring that lookup for ordinary robots. Existing tenant
and insert policies remain intact. Private robots, derived tables and read RPCs
retain the existence-checking guard; direct read authorization also explicitly
requires effective tenant membership. No service-role bypass is added.

The private classification helper is not executable by PUBLIC, anon, authenticated
or service_role. Only the caller-bound candidate helper is granted to authenticated;
it checks membership internally without broadening the existing membership helper's
ACL. It accepts no actor argument. Candidate checks intentionally do not establish
existence for ordinary IDs and must never replace the existence-checking read RPC.
They expose no payload, but can reveal a limited classification distinction for
known IDs; foreign-site membership and null callers fail closed. Missing-ID and
foreign-membership read RPCs still return false.

The canonical correction lives here and byte-identically in the schema repository,
not in a duplicate frontend migration. Applied with explicit authorization only to
`rnjgeloamtszdjplmqxy` on 2026-11-08 at 01:32:29 UTC; independent read-only catalog
and exact-source history verification passed at 01:32:37 UTC. No production robot
insert or business-flow test was performed. See the schema repository's
`supabase/validation/20261108_procurement_workflow_insert_returning.md` for evidence
and TLS limitations. Bootstrap exclusion is unchanged.

Run `PATH=/opt/homebrew/bin:$PATH npm run test:procurement -- --runTestsByPath
src/lib/procurement/__tests__/workflow-insert-returning-postgres.test.ts` for the
real PostgreSQL regression. It creates and destroys a socket-only local cluster,
never reads a configured database URL, and fails if PostgreSQL binaries are
unavailable at `/opt/homebrew/bin`. The
fixture models tenant membership and procurement permission; it is not a full
Supabase schema replay. It proves the original failure, corrected returning row,
tenant/owner denials, private single/array triggers, sticky and derived privacy,
and missing-ID RPC denials. The frontend robot lifecycle test is separately
restricted to explicitly enabled disposable local/staging targets.

## Boundaries

- No new raw quotation or sealed-submission events are enabled. Procurement
  quotations use the shared `quotations` table and need a separate buyer-scope
  and sealed-opening review before extending their existing event behavior.
- Credentials, audits, internal queues and child tables without `site_id` are
  excluded. No procurement grants or approval rules are changed.
- Purchasing events require the canonical instance owner's current procurement
  permission. The instance is classified private before storing the run plan;
  classification remains after subscriptions or runs are removed. Restrictive
  RLS policies and API checks protect plans, logs, runs and context. Privileged
  cloud scope checks also protect generated artifacts. Ordinary members cannot
  read the instance's derived output, even when a manager configured the trigger.
  Permission checks fail closed until the confidentiality migration is installed.
- Every DB mutation gets a UUID in its queued payload. Replaying that payload
  retains its identity, while separate updates receive separate IDs. Legacy
  direct emitters use a canonical row-snapshot hash (including timestamps);
  identical snapshots without an explicit event ID intentionally deduplicate.
  Keys distinguish subscriptions even when they share a template.
- Delivery remains best-effort: this does not install durable retries or old/new
  transition conditions. Tests include isolated PostgreSQL/PGlite execution and
  mocked dispatch; external delivery still needs verification after deployment.

Disable purchasing subscriptions before a rollback. Retain confidentiality
guards and private-instance classifications while any derived purchasing data
remains; removing the guards would expose historical data. Use a reviewed forward
correction for schema rollback and retain the shared webhook function.