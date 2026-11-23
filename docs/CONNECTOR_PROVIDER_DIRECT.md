# Provider-direct connector execution in private Robots turns

## Decisions and ownership

The unit of authorization is a **site-owned connected account**, not a toolkit,
credential string, or model-supplied account name. Multiple connections to the
same service can have different provider permissions. A provider rejection never
selects another connection. No separate function or tool-specific adapter is
registered for each catalog entry.

| Layer | Responsibility |
| --- | --- |
| Direct policy | Current nonanonymous direct Ask session, parent owned by the user, the signed-in member’s connector-use grant, allowed host, local/account/provider state, exact resource binding and current enrollment. The same-site active prompt agent is pinned to the turn, **not** a second connector-grant principal. `all` or exact `selected` (empty means none). |
| Discovery | Query only admitted accounts' provider catalogs. Short bounded pages, no user search text or account secrets in provider search parameters. Domains are navigation metadata, not authorization. |
| Transport | Fetch the actual action and input schema, verify the exact toolkit, private downstream account and auth configuration. Pin the live provider version/schema to this connection. Validate arguments with no credential/substitution, arbitrary fetch, proxy or code execution. Do not reconstruct data access from a list of OAuth scope names. |
| Dispatch and delivery | Reauthorize after describe, immediately before the external effect, before storage and when opening the result. A durable request claim prevents replay of the same call in a turn. Store a bounded redacted field/value preview; the model gets a receipt, not the provider's data, credential or raw diagnostics. |

A direct connection delegates the **actual** permissions of the downstream
credential. It must be independently verified as dedicated to this site's
business resources and unable to widen that boundary on reauthorization.
Verification is per **connection**, not a manual list of provider actions. A
shared Composio project key is transport authentication, not the permission to
use someone else's downstream account. The model cannot create this proof,
enable the connection, switch projects or acquire an administrative token.

In private Ask, `require_approval` is not an onboarding requirement or a
per-call prompt. Already-authorized members and agents use the saved tools
without review. A caller without local use permission cannot execute; a
supported review flow can accept a request for that action instead. Generic
direct actions do not automatically produce review requests. A manager's
decision never upgrades a read-only provider credential or overrides a 403.

The generic dispatcher does not use a reporting compiler or a per-tool registry.
The shared-installation exception is intentionally separate: a positive match of
the selected bound project can advertise **only** `SUPABASE_RUN_READ_ONLY_QUERY`
under its own authorized, scoped contract. A generic failure or provider 403 is
never a reason to reroute an action. Historical report links, Support, approvals
and native `report` remain separate.

### Instance authority and scoped reads: schema applied to shared Makinari

- `20261123040000_connector_instance_member_authority.sql` removes the prompt
  agent's connector-grant veto from interactive Instance discovery, claim, store
  and open. Requests started under the former two-principal rule are not upgraded;
  older direct receipts become unavailable. Drain in-flight work and allow the
  receipt TTL to elapse before rollout. Historical non-direct receipts and
  autonomous Agents are unchanged. Never start a new write to recover an old one.
- `20261123041000_connector_instance_scoped_reads.sql` is for a bounded read on
  the **exact** Supabase account, not delegation of arbitrary SQL or of a shared
  administrative credential. An account eligible for this capability no longer
  disappears from selected-account searches merely because it targets the shared
  project. Local discovery sends no user text, query or secret to the provider.
  Describe/call check the actual tool and account; an opaque receipt is returned.
- The requested source and scope matter even if the credential can read the
  whole database. Workspace scope is tenant-filtered. Platform aggregates need
  the separately issued platform entitlement; never silently shrink a requested
  platform query to workspace totals. These migrations issue no such entitlement.
- Both migrations and the OAuth onboarding migration committed at **07:05:54 UTC
  on November 23, 2026**. Independent PostgreSQL verification at **07:06:02 UTC**
  confirmed the exact sources, installed routines and server-only RPC permissions.
  No account was enrolled, no platform grant was issued, and no application
  or worker was deployed. Real-account acceptance on a fresh turn is still required.

## Cutover

**Shared Makinari:** the policy and receipt migrations were applied together on November 23, 2026 at **05:52:48 UTC**. Do not replay them. A subsequent read-only incident check found two fresh keyed Ask turns, each stopped at tool search with `DIRECT_POLICY_REQUIRED`; the selected Supabase account was connected to the shared installation. No direct reservation was present. This was a local admission denial, not a downstream 403 or a query that returned no rows.

**New-connection default (schema applied in the 07:05 UTC rollout):**
`20261123030000_connector_ask_on_connect.sql` enables one-step setup for eligible
new OAuth accounts. Deploy this prerequisite before the updated API and web.
The Connect screen discloses that authorized users/agents may use saved tools,
including writes. Its `POST /api/connectors/auth-attempts/ask` handler records
the authenticated manager's intent on the new attempt, without admitting any
tool or generating evidence. Old clients, callbacks, historical accounts,
managed auth-configuration creation and the Supabase Management PAT form do
not create this intent. The first valid independent account proof may complete
the setup. Revoking or cancelling must not be reversed by a later proof.

The versioned manager RPCs `connector_ask_policy_status` and
`connector_set_ask_policy` include `setup_pending` in addition to the two CAS
revisions and effective status. Only the API sees the database binding. A
successful exact gateway response may establish the shared-installation reason
for the UI; absence of that evidence never permits execution. Check both saved
catalogue and tool policy and any explicit revocation, not a broader credential.

1. Verify the intended database target and stage `20261123010000_connector_provider_direct.sql`
   followed by `20261123020000_connector_direct_receipts.sql`. No old
   `catalog_reads` or `all` value implies direct consent. No accounts, provider
   keys or downstream grants are created or widened by the migrations.
2. Review the actual downstream credential and resource boundary for each
   participating connection through the operator process. Never attest a shared
   installation, broad project management PAT, arbitrary administrative tool,
   or credential whose scope cannot be independently established. Confirm the
   connecting manager understands that calls may write and incur cost. After
   the forward change, a pending first setup needs no second manager click.
3. Deploy the matching API, worker and workspace builds as one cutover. The old
   runtime is **not** a fallback for missing enrollment or a failed provider call.
   Without direct enrollment a connection cannot use the generic transport.
   The independently authorized scoped read is not a generic enrollment. Managers can
   select individual actions or `all`, enable, and revoke the direct policy.
4. Validate with two disposable accounts of the same toolkit: a newly discovered
   action, an authorized read and explicitly approved write, genuine upstream
   403, selection denial without dispatch, revocation after describe, duplicate
   submission without replay, and private read after revocation. No mock, static
   tool count or successful catalog GET proves a real provider action succeeded.

For rollback, disable direct admission and keep claim/receipt records. Reconcile
an ambiguous outcome with the original provider; disabling access cannot undo
an already dispatched effect. Do not re-enable the old shared credential path.

Direct consent has its own revision. Manager writes compare both the ordinary
connector revision and the direct revision; only the latter advances, and the
change is recorded in the private direct policy journal. Old direct descriptors
and receipts cannot regain access after revocation and re-enrollment. A proof or
consent change by itself does not invalidate historical non-direct report links.

The trusted Ask request ID chooses at most one workflow starter; a duplicate
acknowledgment is not a completed action. Only a new, keyed interactive turn
with its actual prompt agent pinned may reserve dispatch. Claim and storage also
require the requester to see the parent under PostgreSQL `authenticated` RLS.
The gateway checks the validated subject, role and nonanonymous state, not a
persisted bearer token. Re-review enrollment if parent policies come to depend
on extra token claims, MFA, headers or live session state. Only the identical
receipt-storage acknowledgment may be retried; never retry an uncertain provider
action. See [Ask admission and reconciliation](ASSISTANT_RESPONSE_LIFECYCLE.md).

## Limitations

Toolkits exposed only through custom MCP, automatic auth, proxies, workbenches,
arbitrary code/SQL or implicit file loading are not generic business actions.
A provider contract that cannot be validated or an output that cannot be safely
shown is explicitly unavailable/limited, not an empty result. No assertion of
execution coverage for every tool in Composio is made. A Supabase Management PAT
against this installation is not an isolated user credential: only the explicit
scoped action may use the selected account for a server-constrained read. The
generic transport rejects such PATs. Never substitute a service key for the
user’s account or drop tenant isolation to run investor KPIs.

This change replaces **execution**, not every provider's account setup. Existing
OAuth configuration/verification, managed setup and the legacy PAT form remain
separate. In particular `complete_auth` verifies a deferred OAuth exchange;
an arbitrary API-key credential must not be adopted just because a callback says
it is connected. Only a supported, verified connection can reach policy enrollment.