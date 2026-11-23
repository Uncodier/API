# Provider-direct connector execution in private Robots turns

## Decisions and ownership

The unit of authorization is a **site-owned connected account**, not a toolkit,
credential string, or model-supplied account name. Multiple connections to the
same service can have different provider permissions. A provider rejection never
selects another connection. No separate function or tool-specific adapter is
registered for each catalog entry.

| Layer | Responsibility |
| --- | --- |
| Direct policy | Current nonanonymous direct Ask session, parent owned by the user, same-site active prompt agent, member **and** agent use grants, allowed host, local/account/provider state, exact resource binding and current enrollment. `all` or exact `selected` (empty means none). |
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

The former Supabase SQL compiler, report-view registry, curated read profiles
and toolkit-name filter are **not on the private Robots execution path**. Old
published-report links remain bound to their old hash and report-choice handler.
Public Support publications, approvals, and the native Makinari `report` remain
separate; a published channel cannot gain direct execution by guessing a slug.

## Cutover

**Shared Makinari status:** both schema migrations were applied together on November 23, 2026 at **05:52:48 UTC**. The two preexisting connections remain unenrolled. Do not replay the SQL on this target. Matching application/worker deployment and the two-account external acceptance tests below are still pending.

1. Verify the intended database target and stage `20261123010000_connector_provider_direct.sql`
   followed by `20261123020000_connector_direct_receipts.sql`. No old
   `catalog_reads` or `all` value implies direct consent. No accounts, provider
   keys or downstream grants are created or widened by the migrations.
2. Review the actual downstream credential and resource boundary for each
   participating connection through the operator process. Never attest a shared
   installation, broad project management PAT, arbitrary administrative tool,
   or credential whose scope cannot be independently established. Confirm the
   original account owner understands that direct calls may write and incur cost.
3. Deploy the matching API, worker and workspace builds as one cutover. The old
   runtime is **not** a fallback for missing enrollment or a failed provider call.
   Without direct enrollment a connection cannot be used through the new Robots
   gateway, even if restricted legacy reads worked previously. Managers can
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
execution coverage for every tool in Composio is made. In particular a Supabase
Management PAT against the shared Makinari database is not an isolated user
data connection. Use a genuinely isolated downstream business-data interface;
do not substitute a service key or drop tenant isolation to run investor KPIs.

This change replaces **execution**, not every provider's account setup. Existing
OAuth configuration/verification, managed setup and the legacy PAT form remain
separate. In particular `complete_auth` verifies a deferred OAuth exchange;
an arbitrary API-key credential must not be adopted just because a callback says
it is connected. Only a supported, verified connection can reach policy enrollment.