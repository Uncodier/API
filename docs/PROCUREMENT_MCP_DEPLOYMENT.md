# Procurement MCP database deployment

## Target and scope

Applied to the existing PostgreSQL 17.6 database selected by the private
`makinari-db-scheme/.env.local` configuration and its matching cached session
pooler. Credentials, connection strings and customer data are not included here.
This was an explicitly authorized remote migration operation, not a fresh-QA
bootstrap, database reset or application deployment.

## Audit

Compared all 34 canonical procurement migrations in the schema repository with
the frontend copies (byte-identical), the remote migration history, and the latest
81 canonical domain function bodies. Before deployment, 78 bodies matched exactly;
two functions were missing, and the generated-manager helper had an equivalent
formatted definition. Its security-definer/search-path settings and private ACL
were checked separately. The newer decision-replay function was already installed.

## Ordered changes

Executed in one transaction with a deployment advisory lock, a five-second lock
timeout, a sixty-second statement timeout, preconditions and postconditions:

1. **History reconciliation only:** `20261028200000_procurement_default_manager_decisions`.
   Its helper already existed with equivalent behavior. Recorded the canonical
   migration in `supabase_migrations.schema_migrations`; did not rerun its older
   `decide_procurement_event` implementation over the installed
   `20261030160000_procurement_decision_replay` version.
2. Applied `20261029120000_procurement_deprecated_approvals`:
   adds the revision-validation trigger for approval votes.
3. Applied `20261030220000_procurement_quotation_detail`:
   adds the sealed-safe single-quotation projection.
4. Applied `20261031010000_procurement_mcp_bridge`:
   adds the private policy-reference validator and service-only dispatcher.

Migration history inserts and DDL committed together. Notified PostgREST to reload
its schema cache. No customer records, purchases, proposals, votes, orders or
receipts were created or modified by the deployment.

## Verification

- All 34 canonical procurement migration versions and the MCP bridge are recorded.
- All 23 dispatcher dependency signatures resolve.
- Newly installed function bodies match their reviewed SQL files exactly.
- Decision revision trigger is enabled; the existing immutable-history trigger remains.
- The newer decision-replay body was preserved unchanged.
- Dispatcher execution is granted to `service_role`, not `anon` or `authenticated`.
- The policy-reference helper is not directly executable by those roles.
- An authenticated-role negative probe was rejected before domain operations.
- The local procurement suite passed 271 tests before installation.

Business end-to-end calls were not executed against customer records. The API
deployment remains separate from this successful database installation. The
documented distinction between MCP snapshot checks and the separate UI approval
path remains unchanged.

## Applied source SHA-256

| Migration | SHA-256 |
| --- | --- |
| `20261029120000` | `6df16e4da3203a4816561b0174af65ae94b577a74439bb8cbfe60eed844863f1` |
| `20261030220000` | `8b6155e2f5ce3d67e46e1c7f0f9dba747a04db10a1bea4f539622124234e2b6e` |
| `20261031010000` | `8853b0ef1d4a975d2f2ca70c45cad4c80324c3e13fe66348f23b7532836ab057` |

The history-only reconciled source `20261028200000` has SHA-256
`29657a0b796772b07f6a1e8dd0a86ecefab0f35631c357556804bec5f1a82475`.