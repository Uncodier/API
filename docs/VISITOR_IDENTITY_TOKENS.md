# Server-issued visitor identity tokens

## Trust boundary

An email/name supplied by a browser is not identity proof. Plain
`POST /api/visitors/session/{session_id}/identify` now records bounded, private
unverified attributes and returns `identity_status: "unverified"`. It does not
send an OTP, create a lead, grant history, or change an existing grant.
The older `/api/visitors/identify` route also accepts only unverified attributes,
requires independent visitor proof, and no longer performs lead/visitor merges.

Explicit email verification remains available through
`POST /api/visitors/session/{session_id}/identify/challenge`; its challenge,
verify, resend, cancel, and new-lead semantics remain available. Clients must
opt into that flow. Token exchange never invokes OTP orchestration.

Every token endpoint authenticates inside its handler. Middleware strips
client principal metadata and delegates these exact routes without invoking
the generic global/service-key shortcut. Visitor proof is verified separately
even when a caller has a valid user bearer or API key.

## Configuration and migration prerequisite

- `VISITOR_IDENTITY_SIGNING_SECRET`: a dedicated random secret of at least
  32 UTF-8 bytes. Never reuse the session, OTP, API, or encryption key.
- `VISITOR_IDENTITY_SIGNING_KEY_ID`: a required 1–64 character identifier using
  letters, digits, `_`, or `-`.
- Existing visitor-session signing configuration, Supabase configuration, and
  production Upstash admission configuration remain required.

There are no signing fallbacks. Missing/short configuration fails closed with
503. Deploy the same secret/key ID to all issuing and exchanging instances.
Only one signing key is accepted: changing it immediately invalidates pending
tokens. It does not by itself revoke already-established grants.

Apply these local forward-only migrations in order:

1. `supabase/migrations/20260929210000_visitor_identity_tokens.sql`
2. `supabase/migrations/20260929221000_identity_credential_versions.sql`

They require the existing visitor identity OTP migrations, including hardening
and active challenge reuse. The correction adds a database-controlled credential
version and `exchange_visitor_identity_token_v2`. The old exchange function is an
owner-only internal helper: direct service-role access is revoked. Deploy the
correction before the repaired API; missing version/RPC configuration fails
closed. Neither migration has been applied remotely by this implementation.

On 2026-09-29, read-only REST OpenAPI metadata from project
`rnjgeloamtszdjplmqxy` confirmed the existing API-key, visitor session, grant,
challenge, lead, visitor, and site columns and RPC names. Management read-only
SQL was denied (403). REST metadata cannot attest to all triggers, constraints,
or function bodies; review those against the target before approved rollout.
Later read-only SQL metadata checks on 2026-09-29 confirmed the API-key and grant
columns and the absence of the new token tables/RPC in the target project.
No production records, auth, or OTP calls were used for verification.

## Issuance

### Customer server integration

`POST /api/visitors/identity/token`

Required headers:

- `Content-Type: application/json`
- `x-api-key`: an exact active database-backed key, with non-null `site_id`,
  explicit `identity:issue` scope, and unexpired credentials.
- `x-visitor-session-token`: valid proof for the target session.

Body:

```json
{
  "session_id": "<uuid>",
  "external_user_id": "your-immutable-user-id",
  "name": "Optional display name",
  "email": "optional@example.com"
}
```

The caller must authenticate its own user on its server before issuing. Never
accept `external_user_id` from an unauthenticated browser as authoritative.
The API derives site and issuer from the key, not the body. It rejects unknown
fields, wildcard-only credentials, environment/global/service shortcuts,
Bearer credentials, and requests bearing browser Origin/fetch metadata. New
keys must have `lookup_hash`; legacy keys without indexed lookup must be
reissued. Validation bypasses the generic positive API-key cache.

Provisioning `identity:issue` through `/api/keys` requires an independently
validated first-party user bearer and ownership of the specific site. A
read/write API key cannot mint an issuer. The migration additionally guards
direct Supabase API-key inserts/updates for this scope. Broader manager roles
are not implicitly granted issuer-provisioning authority.

### First-party support identity

`POST /api/visitors/identity/token/current-user`

Body is strictly `{ "session_id": "<uuid>" }`. Requires both Supabase
`Authorization: Bearer <access-token>` and `x-visitor-session-token`. The server
calls `auth.getUser` against the pinned first-party Supabase realm, never trusts
decoded JWT claims or profile fields, and uses the returned user ID as subject.
Anonymous users and non-user roles are rejected. Only `email_confirmed_at`
allows the auth user's email into the signed, non-authoritative attributes.
Bounded auth `user_metadata.name`/`full_name` is display-only.

Target support site is pinned to `9be0a6a2-5567-41bf-ad06-cb4014f0faf2`.
No workspace-manager requirement applies: any authenticated first-party user
may identify **only themselves** to support. The issuer is
`supabase:rnjgeloamtszdjplmqxy`; caller-selected sites/users are forbidden.

Both issuance routes return:

```json
{ "success": true, "data": { "identity_token": "<opaque>", "expires_at": "<ISO timestamp>" } }
```

Tokens expire after 90 seconds. Success and error responses use
`Cache-Control: no-store`. Treat tokens as transient secrets: do not log them
or persist them in cookies/local storage. Retrying issuance produces a new JTI.

## Browser exchange, restore, logout

`POST /api/visitors/session/{session_id}/identify/token` requires the same
visitor session proof and strict JSON body:

```json
{ "site_id": "<uuid>", "session_id": "<uuid>", "identity_token": "<opaque>" }
```

No email, name, lead, user, or override fields are accepted. HMAC-SHA256
validation checks purpose/version/key ID, exact 90-second lifetime, issue and
expiry times, JTI, issuer/credential, and site/session/visitor binding. A single
database RPC atomically maps the stable identity, consumes JTI, and grants:

```json
{ "success": true, "data": { "identity_status": "verified", "lead_id": "<uuid>", "expires_at": "<grant expiry ISO timestamp>" } }
```

`GET /api/visitors/session/{session_id}/identify/status?site_id=<uuid>&session_id=<uuid>`
derives the current active grant from session proof; no email or lead hint is
needed. It returns verified/lead ID/grant expiry or `identity_status: "anonymous"`. The
legacy OTP POST status contract remains supported.

`DELETE /api/visitors/session/{session_id}/identify/logout` requires session
proof and `{site_id, session_id}`, returning 204. It increments the private
session epoch under the same lock used by exchange, revokes the grant, cancels
pending challenges, and clears the session lead. Both consumed and unconsumed
pre-logout tokens are invalidated. A different subject cannot replace a bound
identity without explicit logout (`identity_conflict`, 409).

## Stable mapping and revocation

- API keys share one external identity namespace per site in v1:
  `integration:<site_id>`. Immutable external ID + issuer + site selects one
  lead. Credential IDs are separately signed and checked at redemption, so
  normal key rotation to a newly-issued key preserves identity/history.
  Prefer rotation by creating a new credential and revoking the old credential.
  A signed SHA-256 fingerprint of the stored encrypted credential is checked
  under the credential lock; replacing its material in place also invalidates
  pending tokens. Neither the credential nor its ciphertext enters the token.
  The signed `key_version` is also checked under that lock. Changing status,
  site, owner, lookup hash, encrypted key, scopes or expiry rotates a random
  database-controlled version and revokes active grants. Restoring an old value
  cannot revive pending tokens. Name/usage-only updates leave the version intact;
  caller-supplied version changes are ignored. Pre-correction integration tokens
  without a version are rejected; first-party user tokens have no key version.
- Mapping never searches or merges by email. Token-created `leads.email` is
  null; display/contact attributes are stored in the private mapping table.
  A grant trigger prevents OTP/new-lead paths from claiming a token-only lead
  even if someone later edits its CRM email. Such linking needs a separate,
  explicitly authorized migration/product flow; it is not automatic.
- Identity grants last at most 15 minutes, capped by API-key expiry. Clients
  should obtain a fresh token and exchange approximately every 10 minutes.
  A retry with the same JTI is allowed only while its exact grant and token
  remain active; it cannot resurrect a revoked/expired/superseded grant.
- Key revocation, deletion, permission/ownership/material changes, or any expiry
  change revokes matching active grants. New exchanges check the credential
  under a row lock. Mapping survives replacement credentials. Supabase signout
  must also invoke visitor logout; there is no cross-product global signout
  webhook. Otherwise grant expiry bounds the stale authorization window.
- Anonymous conversation access never falls back to remembered visitor ID
  for a conversation owned by a lead. Logout does not reveal account history
  through anonymous conversation lists.
  SSE and the standalone WebSocket proxy revalidate before each history/message
  delivery and on idle heartbeats, including the session epoch and grant
  generation. A connection cannot survive logout/relogin as the same subject.
- SSE callers authenticated without a visitor grant must present their original
  API-key or user-bearer proof. Every protected delivery revalidates current
  credential status, expiry, site access and principal identity without the
  generic positive authorization cache. Database keys need `read` or `*` for
  this history stream; `identity:issue` alone is not permission to read it.
  Credential-version changes also close existing streams. User bearer checks
  call Auth with the original JWT and check current membership; global service
  credentials are compared with the current server environment. Initial
  middleware metadata alone never authorizes continued delivery.

## Bounds and offline checks

Identity JSON bodies are streamed with an 8 KiB limit, including chunked
bodies. Subject/name/email lengths are bounded; signing token max is 4096
characters and visitor proof max is 2048. Issuance/exchange/logout have route
admission limits that fail closed in production when the limiter is unavailable.
Current-user pre-auth admission tolerates shared BFF egress (1200/minute), with
a separate 30/minute authenticated-subject limit. Other routes use 60/minute
pre-auth and 30/minute site/session limits where applicable.

Run offline Jest (CommonJS harness mode; no Next/env loading):

```sh
PATH=/opt/homebrew/bin:$PATH npm exec -- jest --config jest.identity.config.js --runInBand
```

This covers tamper/malformed/expired claims, cross-site/session/visitor and
subject changes, exact issuer/scopes, first-party auth, strict bodies, rate
limits, replay/revoke/error envelopes, logout, plain attributes, and OTP
regressions. Run the isolated PostgreSQL integration fixture as well:

```sh
python3 scripts/visitor-identity-pg/run.py
```

The [fixture guide](../scripts/visitor-identity-pg/README.md) documents its
private Unix-socket cluster, actual lock-race tests, teardown and limitations.
It does not bootstrap the entire production schema. Never run live auth/OTP,
production builds, remote migrations or deployment as part of these tests.