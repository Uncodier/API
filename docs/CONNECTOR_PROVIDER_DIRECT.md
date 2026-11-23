# Provider-direct connector execution in private Robots turns

## Current local contract (not deployed)

After `20261123110000_connector_instance_member_policy.sql`, private Instance execution uses the signed-in member’s use grant, the site’s selected connection and its assistant/tool policy. A current site-isolated downstream binding is sufficient for supported generic actions; a second enrollment record is not required for a fresh turn. Explicit disables remain vetoes. Historical receipts keep their prior authority. Support uses the assigned agent and enforces its output policy for the audience; Support is not a gateway for arbitrary provider actions.

For a host-selected, bound Supabase connection, `SUPABASE_RUN_READ_ONLY_QUERY` also supports an exact `SELECT 1` connectivity check without generic downstream data access. This calls the actual provider action and returns confirmation only. It is **not** a table read, a general SQL capability, a KPI report or evidence that a provider accepted a live production request. No caller-supplied SQL is sent to a shared administrative credential. A provider rejection is final; the runtime does not try a different credential.

## Decisions and ownership

The unit of authorization is a **site-owned connected account**, not a toolkit,
credential string, or model-supplied account name. Multiple connections to the
same service can have different provider permissions. A provider rejection never
selects another connection. No separate function or tool-specific adapter is
registered for each catalog entry.

| Layer | Responsibility |
| --- | --- |
| Direct policy | Current nonanonymous direct Ask session, parent owned by the user, the signed-in member’s connector-use grant, allowed host, local/account/provider state, exact resource binding and no explicit opt-out. The same-site active prompt agent is pinned to the turn, **not** a second connector-grant principal. `all` or exact `selected` (empty means none). |
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

### Historical single-save contract (superseded for new turns)

For a currently verified isolated account, the manager can enable Ask and save its tool policy in **one** `PATCH /api/connectors/connections/[id]/policy`. An explicit change sends `ask_access: {enabled, expected_direct_revision}` with the ordinary `expected_revision`. The server validates any selected tool IDs and sends one transaction to `connector_save_policy_with_ask`. It confirms the exact account, both advanced revisions and the resulting permission. If the transaction fails, neither decision is applied. If acknowledgement is lost, reload before acting; do not replay the save or fall back to two requests.

An ordinary policy save without `ask_access` does not implicitly adopt, enable or re-enable an account. Previously disabled accounts remain disabled. The internal enrollment identifies the exact credential verification for revocation and receipt checks; it is maintained by the same save, not a second permission the manager must grant. Catalog browsing does not imply execution. Saving Ask access does not establish isolation for a shared administrative credential or enable arbitrary SQL. The migration must precede the matching API and web release; no provider calls or account backfills are part of the migration.

## Choosing the source and account in private Ask (local contract)

| User asks for | How to discover it | Exact reference to describe and call |
| --- | --- | --- |
| An action on a connected app (calendar, CRM, inbox, commerce, etc.) | `tools` search/list with `tool_origin: "provider"`; keep the selected `connector_id`. This is the default connector inventory. | `connector:<id>:<SLUG>` |

Candidates and descriptors carry `tool_origin`, `toolkit`, `connector_id` (the **local** account UUID), and `account_label`. The label is `Account …` plus the last eight characters of the local ID, as shown in the Ask picker. Never interpolate `display_name`, a provider account ID, email, credential, or arbitrary account metadata into the prompt. The label is a hint, not a routing key. Keep the full ID and exact returned name through describe and call.

For example, two calendar connections may both list the same update action. Without a selection, follow the cursor, including empty pages, before concluding there is just one candidate. If the member has not specified which account, ask which one to use. If suffixes collide, ask for a selection in the account picker. **All tools** is a Makinari policy for that account; it cannot turn a read-only credential into one that can update events. A missing tool, provider denial or partial page does not authorize use of the other account.

**Retired Ask report (local cutover).** The scoped Makinari metrics report is no longer a connector action. Its old origin and qualified references cannot be searched, described or called. Do not substitute the native `report` tool, a provider query or a different account. The requester can still open authorized, unexpired historical private receipts. Report-qualified names remain private in diagnostics. The native `report` and ordinary provider discovery are unchanged.

Deploy compatible API, workers and web first and drain older workers before applying `20261123090000_retire_instance_scoped_report.sql`. The forward migration closes scoped-report discovery and new claims/stores; it does not revoke generic member authority, reset connector policies or delete receipts. No remote migration or deployment is part of this local retirement.

### Earlier instance authority and scoped reads: schema applied to shared Makinari

- `20261123040000_connector_instance_member_authority.sql` removes the prompt
  agent's connector-grant veto from interactive Instance discovery, claim, store
  and open. Requests started under the former two-principal rule are not upgraded;
  older direct receipts become unavailable. Drain in-flight work and allow the
  receipt TTL to elapse before rollout. Historical non-direct receipts and
  autonomous Agents are unchanged. Never start a new write to recover an old one.
- `20261123041000_connector_instance_scoped_reads.sql` introduced the historical scoped read. The later `20261123080000_connector_instance_report_sources.sql` supplied its authorized sources; it was applied to shared Makinari at **07:44:43 UTC** on November 23, 2026 and independently verified at **07:44:52 UTC**. Neither migration granted platform access. Do not roll them back to retire the Ask action.
- The member-authority, scoped-read and OAuth onboarding migrations committed at **07:05:54 UTC
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
   The retired scoped read is not a generic enrollment. Managers can
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

For an explicitly selected active account without direct admission, private Ask can still list provider catalog metadata when the member can use that account and its saved catalog, assistant and tool policies allow it. These candidates are `manual_only`, not calls or report suggestions. Discovery does not grant access to provider data. This rule is independent of toolkit or project identity and does not require a database migration.

## Limitations

**Which checks can stop `call`?** The saved member/host/tool policy (`all` or `selected`) controls who can request the operation. Separately, this runtime currently requires a verified interactive turn, current isolation proof for that exact account and no explicit opt-out, a private supported auth configuration, and an immutable supported tool contract. It excludes control-plane actions, arbitrary code/SQL, network/file transports and credential or tenant selectors. These are implementation and isolation restrictions, **not** extra OAuth scopes or evidence of a provider denial. In particular, an authorized member alone cannot delegate a project-wide management PAT on the shared database. A provider rejection after dispatch is final for that account. No path should ask for a broader token to fix a local format error.

Optional display labels and unfamiliar effect tags are not access controls. The generic input validator accepts local `definitions` and `$defs`, closed zero-argument objects, and string formats `date`, `date-time`, `email` and `uuid`. It validates the declared arguments, never resolves external references, and does not inject report-specific arguments into provider calls.

Toolkits exposed only through custom MCP, automatic auth, proxies, workbenches,
arbitrary code/SQL or implicit file loading are not generic business actions.
A provider contract that cannot be validated or an output that cannot be safely
shown is explicitly unavailable/limited, not an empty result. No assertion of
execution coverage for every tool in Composio is made. A shared installation credential cannot satisfy independent workspace isolation proof. A private API key requires the same proof as any other credential; there is no special report exception. Never substitute a service key for a user’s account.

This change replaces **execution**, not every provider's account setup. Existing
OAuth configuration/verification, managed setup and the legacy PAT form remain
separate. In particular `complete_auth` verifies a deferred OAuth exchange;
an arbitrary API-key credential must not be adopted just because a callback says
it is connected. Only a supported, verified connection can reach policy enrollment.