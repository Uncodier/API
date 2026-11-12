# Customer OpenRouter connection backend

Implementation checkpoint: 2026-11-12. Local code and offline tests only; no
remote migration, deployment, paid selector, or provider generation was run.

Historical first-pass contract. The continuation adds automatic selection,
consented image verification and setup status; see
[current validation](OPENROUTER_COMPLETION_VALIDATION.md). The manual-only and
hardcoded-gate statements below do not describe the latest continuation.

## Availability boundary

Connections, private catalog discovery, exact manual pins, refresh and disconnect
are implemented. **Customer execution activation is deliberately blocked** in
both TypeScript and the publication RPC until runtime propagation is complete.
No environment toggle bypasses this gate. A connected account is not selected;
existing global providers and funding remain unchanged. Selecting it returns
`409 OPENROUTER_RUNTIME_NOT_READY`. Do not present this checkpoint as complete
customer-funded production execution.

API-key connection satisfies the key-or-OAuth design alternative. OAuth and AI
recommendations are not implemented. There are no paid setup calls or probes.
The manual policy editor is the supported configuration path. No capability is
reported live verified from catalog membership. `verifiedAt` is **key/account
validation time**, not evidence of successful model generation.

## HTTP contract

Backend routes (Node runtime):

- `GET /api/integrations/openrouter?siteId=<uuid>`
- `POST /api/integrations/openrouter`
- `GET /api/integrations/openrouter/models?siteId=<uuid>`

Each route validates the user's Supabase Bearer JWT and checks
`current_user_site_role` using a user-scoped client. Only owner/admin may inspect
or manage the account-private catalog. Forwarded user/site/API-key metadata is
not authentication. The web server must perform its own authorization too.
Responses are `Cache-Control: no-store`; no route returns a plaintext key,
credential suffix, ciphertext, provider key metadata, or raw upstream errors.

Root responses:

```ts
{
  canManage: true,
  rolloutEnabled: false,
  selectionMode: 'manual',
  paidSelectionEnabled: false,
  connection: null | {
    id, siteId, status: 'connected' | 'disconnected', selected: false,
    revision, policyVersion, credentialVersion,
    capabilities, catalogUpdatedAt, verifiedAt, updatedAt
  }
}
```

Capabilities are a complete object map with keys `text`, `tools`, `structured`,
`vision`, `summary`, `embedding`, `image`, `speech`, `transcription`, `video`.
Each value is `{mode:'manual'|'disabled',modelId:string|null,
status:'available'|'unverified'|'unavailable'|'disabled',reason:string}`.
Supported text/tool/structured/vision/summary models are `unverified`, not
`available`. Image generation requires successful connection-specific real
verification before enablement; no verification endpoint currently exists.
Embeddings require an explicit existing-index space/dimensions binding. Media
protocol compatibility is not inferred from model names or modality alone.

Models response: `{models:[{id,name,inputModalities,outputModalities,
supportedParameters,contextLength}],catalogUpdatedAt}`.

Every POST requires `siteId` and integer `expectedRevision` (`0` for no row):

- `{operation:'connect',apiKey,consent:true,selected?:false}` validates the key
  and account-filtered catalog, encrypts the credential, and CAS publishes.
  Reconnecting rotates the credential revision and preserves manual pins.
- `{operation:'configure',selected?:false,consent?:true,capabilities?:{[key]:
  {mode:'manual'|'disabled',modelId?:string|null}}}` applies partial overrides.
  Manual IDs must be exact catalog IDs (or unchanged unavailable existing pins).
  Incompatible choices can be saved only as unavailable, not executable.
- `{operation:'refresh'}` synchronously performs free discovery with a durable
  60-second claim. Only one active refresh per connection; busy/stale is 409.
- `{operation:'disconnect'}` removes credential and catalog, deselects, increments
  credential/revision, and invalidates in-flight publication.

No `automatic`, client status, endpoint URL, payer, paid-probe flag, or arbitrary
identity fields are accepted. Mutation bodies are bounded to 32 KiB. Errors are
`{error:string,code:string}`: authentication 401, forbidden 403, invalid input
400/413/415, incompatible/missing model 422, conflict 409, upstream/storage 502/503.
Failure leaves the last published snapshot unchanged; the response gives a safe
error and `catalogUpdatedAt` indicates snapshot age. Persistent refresh history,
progress polling, AI recommendations and catalog diffs are not implemented.

## Storage and secrets

Set server-only `OPENROUTER_CREDENTIAL_ENCRYPTION_KEY` to a cryptographically
random 32-byte key encoded as canonical base64. There is **no fallback** to
`ENCRYPTION_KEY`, an environment OpenRouter key, a public secret, or a default.
Provision via the deployment secret manager. Rotating this encryption key needs
an explicit re-encryption/reconnection procedure; multi-key decryption is not
implemented. Do not change it without accounting for existing ciphertext.

Credentials use AES-256-GCM, independent random 96-bit nonces, 128-bit tags and
AAD bound to site, connection and credential revision. Only ephemeral runtime
resolution decrypts. No browser table grants exist, including ciphertext reads.

Forward migration in the shared web repository:
`supabase/migrations/20261112010000_openrouter_customer_connections.sql`.
Tables are connections, immutable policies and immutable customer receipts.
`service_role` has SELECT only; security-definer RPCs own mutations, fixed search
paths, actor checks and advisory/row-lock CAS. Receipt rows have fixed customer
payer and zero platform charge. Manager checks use existing sites ownership,
site_ownership and active unsuspended owner/admin site_members. Those columns
were confirmed by the lead using read-only schema metadata; no remote SQL was
applied. Deploy the migration before enabling code paths that read these tables.
A missing table/outage is an error, never evidence of an absent connection.

## Runtime integration contract

Server-only `src/lib/integrations/openrouter/store.ts` exports:

- `getCustomerSelection(siteId)` returns null only for no row or explicit
  deselection; otherwise `{siteId,connectionId,revision,policyVersion,
  credentialVersion,capabilities}`. Supply only a server-authorized site.
- `resolveCustomerCredential({siteId,connectionId,policyVersion,
  credentialVersion})` checks current connected selection and credential revision,
  reads the exact immutable historical policy, and returns `{apiKey,capabilities,catalog}`. The current normalized catalog supports
  actual-model context budgeting and current catalog availability checks.
  No caching. Revocation, rotation, missing policy and outages throw. Never put the
  result into workflow history, logs, DTOs or stored execution state.

Revisions are positive integers. Old policy versions can serve already-pinned
work while new policy revisions publish; credential rotation/disconnect stops
future dispatch. Dispatch must separately enforce capability status: disabled
or unavailable means fail closed, and images require `available` live evidence.
There is no implicit Makinari-funded fallback. Runtime propagation and receipt
writers are owned by the runtime modules, not the management routes.

Free discovery fetches only fixed HTTPS URLs `/api/v1/key` and
`/api/v1/models/user?output_modalities=all` on `openrouter.ai`, with redirects
rejected, 15-second timeouts, bounded streaming bodies and strict normalized rows.
Malformed/partial or duplicate catalogs are rejected, not mistaken for complete
removals. Successful complete empty catalogs preserve manual pins as unavailable.

## Offline validation

From the API repository:

```sh
node ./node_modules/jest/bin/jest.js --config jest.openrouter-connection.config.js --runInBand
```

Tests cover encryption/AAD/tamper, no fallback secret, redaction, JWT/manager and
cross-site denial, fixed free provider URLs, catalog validity, manual pins,
activation gates, CAS publication and revocation. The migration suite starts and
removes a disposable socket-only PostgreSQL cluster using local PG17 binaries;
it never reads a database URL. It exercises real concurrent CAS, SQL grants,
manager authorization, refresh/save/disconnect races and receipt idempotency.
It explicitly skips database execution if local binaries are absent. These are
not live OpenRouter execution, balance, grant deduction or deployment evidence.
