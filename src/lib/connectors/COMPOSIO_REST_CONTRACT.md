# Composio provider contract evidence

Numbered pagination uses the provider's base64 page/limit cursor representation
(`2-50` for toolkit page 2, `2-20` for tools page 2), verified against returned
cursors. Direct last-page GETs succeeded for toolkits page 37 and Gmail tools
page 4. This is navigation metadata only and never replaces current authorization.

The detail Tools tab uses documented `GET /tools?toolkit_slug=...&limit=20` with
`include_deprecated=false` and optional cursor. This metadata-only projection
validates every returned toolkit identity, strips schemas and unknown fields, and
never feeds catalogue-only actions into the execution allowlist. Live Gmail page
one and two each contained 20 distinct entries (61 total). Reference:
https://docs.composio.dev/reference/api-reference/tools/getTools.md

The authenticated Tools route accepts an optional `q` (1–200 characters),
forwarded as `query`, the documented full-text filter over name, slug and
description. Filtering occurs at the provider before pagination, not on the
visible page. Policy PATCH verifies all submitted exact slugs, including those
already saved, against the same workspace credential and toolkit. The provider's
`tool_slugs` batch filter overrides other filters, so the response must confirm
each exact slug, its parent toolkit and nondeprecated status. At most 100 IDs,
12 per GET, one transient GET retry across the entire validation. No mutation is
attempted on incomplete or failed lookup. Saving a catalogue-only action does
not make it available to runtime search, describe or execution. These contracts
were verified with offline transport tests, not live project credentials.

Both tool listings accept a bounded `action` filter and expose only normalized
`action_types`, derived from the four [Composio hints](https://docs.composio.dev/docs/governance/tool-hints).
Known filters use the documented provider `tags` filter before pagination;
`unclassified` uses a bounded metadata scan because there is no negative tag
filter. A timeout or scan cap returns an error instead of a partial count.
Provider hints never change reviewed-tool membership, scopes, or approval policy.

Detail follow-up: Google Calendar returns `{slug: "scheduling-&-booking", name}`
where the listing uses `id`. Both category identifier fields now share the same
bounded validation; toolkit slugs remain stricter. Live Google Calendar detail
and auth-config reads succeeded after the fix (zero existing auth configs).
Connector regression suite: 253 tests passed. No OAuth or tool execution occurred.

Live read-only catalogue validation on 2026-11-19 after project-key replacement:
`GET /toolkits` returns category `{id,name}` entries, including IDs containing
ampersands such as `scheduling-&-booking`, rather than always `{slug,name}`.
The catalogue adapter accepts both bounded identifier forms and normalizes them
for classification only; toolkit/account identity checks remain unchanged.
The corrected adapter parsed 50 live catalogue entries and Gmail detail. No OAuth
or tool execution was performed. Regression suite: 249 tests passed.

Public documentation fetched 2026-11-19. No credentials or provider state changes
were used. All requests use `https://backend.composio.dev/api/v3.1` and per-request
`x-api-key`; no SDK or ambient provider credential fallback.

| Operation | Exact documented method/path | Public reference |
| --- | --- | --- |
| Catalogue | GET `/toolkits` | [List](https://docs.composio.dev/reference/api-reference/toolkits/getToolkits.md) |
| Toolkit detail | GET `/toolkits/{slug}` | [Detail](https://docs.composio.dev/reference/api-reference/toolkits/getToolkitsBySlug.md) |
| Auth configs | GET `/auth_configs` | [Configs](https://docs.composio.dev/reference/api-reference/auth-configs/getAuthConfigs.md) |
| Connect link | POST `/connected_accounts/link` | [Link](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink.md) |
| Callback proof | POST `/connected_accounts/complete_auth` | [Complete](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsCompleteAuth.md) |
| Account identity | GET `/connected_accounts/{nanoid}` | [Account](https://docs.composio.dev/reference/api-reference/connected-accounts/getConnectedAccountsByNanoid.md) |
| Filtered owner proof | GET `/connected_accounts?user_ids=...&connected_account_ids=...` | [Accounts](https://docs.composio.dev/reference/api-reference/connected-accounts/getConnectedAccounts.md) |
| Upstream revoke | POST `/connected_accounts/{nanoid}/revoke` | [Revoke](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsByNanoidRevoke.md) |
| Versioned schema | GET `/tools/{tool_slug}?version=...` | [Schema](https://docs.composio.dev/reference/api-reference/tools/getToolsByToolSlug.md) |
| Pinned execution | POST `/tools/execute/{tool_slug}` | [Execute](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteByToolSlug.md) |

Connect Link returns `connected_account_id`, `redirect_url`, `expires_at` and a
discarded `link_token`. Completion consumes opaque `session_uri` plus trusted
`user_id`, returning the exact account/toolkit after activation. The caller must
bind initiating actor, nonce, expiry, credential revision and pending account in
durable state; no status-success or callback-account-ID fallback is accepted.
Project/verifier binding is the separate operator-attestation module, not claimed
project-key introspection. Provider `user_id` is deprecated in account responses;
missing owner identity requires the documented filtered exact-account query.

The chosen backend deliberately uses pinned direct REST execution because
[session creation](https://docs.composio.dev/reference/api-reference/tool-router/postToolRouterSession.md)
and [session execution](https://docs.composio.dev/reference/api-reference/tool-router/postToolRouterSessionBySessionIdExecute.md)
do not expose a version selector. This is not an automatic fallback. The runtime
must supply reviewed tools/scopes, validated arguments, a descriptor hash, exact
account and fresh authorization callback. There are no sessions, auth-management,
Instant, proxy, workbench, remote files, natural-language execution or batch calls.

Revocation requires confirmed exact `REVOKED`; delete's asynchronous revoke job is
not evidence of upstream revocation. Network/timeout/5xx/malformed write outcomes
are unknown, never auto-retried. Structured scope requirements remain blocked
until reviewed; absent granted scopes do not grant access. Tests are offline
contract/security checks, not OAuth interoperability or live-provider acceptance.

Tool-specific public evidence:
[Gmail](https://docs.composio.dev/toolkits/gmail.md) documents `GMAIL_FETCH_EMAILS`
with optional `user_id`: `me` selects the authenticated account; another address
requires domain delegation. The runtime removes that field from model inputs and
the adapter injects `me` only for this reviewed action when present in its pinned
schema. Caller-supplied `user_id` remains rejected. The schema hash covers the
original provider schema. [HubSpot](https://docs.composio.dev/toolkits/hubspot.md)
documents the reviewed `HUBSPOT_LIST_CONTACTS` read action and its pagination fields.
## Supabase table metadata (2026-11-20)

The [official Supabase catalogue](https://docs.composio.dev/toolkits/supabase)
(toolkit version `20261116_00` at review) documents `SUPABASE_LIST_TABLES`,
not an arbitrary SQL operation. Its flat permission is `Database:Read`. The
adapter requires that exact live descriptor permission and no structured scope
requirements, then hashes/pins the original schema and version. The model's
entire argument object is `{}`. The server supplies only a verified connection's
20-lowercase-letter `project_ref`, and explicitly disables `include_metadata`,
`include_views`, and `include_system_schemas`. Omitting `schemas` requests all
non-system schemas. Neither SQL nor row-selection tools are reviewed here.

The hosted API-key flow does not report OAuth grants. Its PAT permission is
enforced by Supabase on the exact pinned operation, never converted into an
OAuth scope or reused for another action. Immediately before dispatch the
adapter verifies the bound account/project/owner/auth config/credential revision
and requires `state.authScheme: API_KEY` and the exact hosted management origin
in `state.val.full`, or the observed masked `http...` paired with the exact
resolved `data.base_url`. A mask alone or conflicting origins never qualify. Unsupported identity, origin,
descriptor or missing project binding fails closed. The Connectors and
Applications Database screens both apply. Customer-channel proposals exclude
this private action even if the connector policy permits all compatible tools.

The published output specifies the execution envelope but not a stable nested
`data` shape. The local adapter recognizes only explicit table-name collections,
returns bounded schema/name pairs, and does not return rows, provider diagnostics
or raw payloads. Schema discovery may fall back to `public` and may partially
fail. Do not promise an exhaustive inventory. Unknown result shapes and
over-limit results are rejected, not silently treated as an empty database.
The new operation was verified against public documentation and offline
transport fixtures only. Validate a redacted real result on an approved test
account before declaring live acceptance; do not loosen the projection to
pass through arbitrary data.

### Supabase project metadata and Ask

The historical `POST /api/connectors/connections/{id}/bind-project` workflow
has been removed from the API and web. It recorded a project after a metadata
read; it did not grant Ask execution. Existing project references and saved
delegations are not rewritten. The manager's Ask status is projected from the
authorization RPC, regardless of whether it also returns a private project
reference. That reference never reaches the browser. Project-scoped execution
still checks the exact authorized project.

Deploy the updated API and web before applying
`20261123164000_retire_connector_project_binding.sql`. It removes only the
retired writer and makes the existing references immutable; it does not reset
Ask policy or issue an authorization.
