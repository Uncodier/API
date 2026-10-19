# Current resource licenses at execution

Outgoing execution must not authorize a sender from the raw `settings` mirror.
A Startup trial can expire without a settings write. The server-only
`getSiteLicensedResources` helper calls `get_site_licensed_resources(p_site_id)`
on every use, with a ten-second maximum RPC wait and caller cancellation.
Missing RPCs, database errors, unavailable/archived sites, malformed projections,
deny execution without a raw-settings fallback.
Unavailable projection raises a safe 503; a selected unlicensed resource raises
403. Existing delivery adapters may translate these into their safe failure DTO.

## Covered boundaries

- Exact distribution routing and the exact adapter's final dispatch check.
- Generic Zavu channel sends, including a second check after audio preparation.
- Prepared outreach Zavu delivery closures, pinned transactional Zavu email
  sender resolution and every recipient dispatch.
- Tracked voice sender selection and provider call placement.
- Workflow channel connection resolution, including stored exact destinations.
- Outstand post creation, public comment replies, and Instagram DM sends at the
  shared provider client, plus social publishing preflight before content writes.

Generic channel sends without an exact destination retain deterministic stored
connection order: use the first available licensed sender, skipping suspended or
disabled connections. Multiple licensed senders are not an ambiguity error. The
chosen connection ID and sender are rechecked after audio preparation; expiry
denies that send instead of silently switching to another account.

The exported `isChannelActiveStatus` helper accepts `connected`, `active`, and
`synced` only for `voice`; every other channel accepts `connected` only. A
provider-active status never replaces `license_suspended === false`. Legacy Voice
placement and optional exact Voice selection share this rule, and final dispatch
rechecks the original site-scoped connection ID and sender after contact context
preparation. Duplicate connection IDs, changed senders, disabled connections, and
projected trial-expiry suspension remain denied.

Each caller must authorize the execution site first. Social mutations additionally
require the exact licensed account, not merely a live provider account. DM callers
forward the already-authorized site into `sendConversationMessage`. Unscoped
legacy Outstand workflow post creation now fails closed rather than selecting a
global provider tenant. The posts collection route validates site access itself.

`OutstandClient.createPost` wraps only failures before the provider mutation in
the trusted `OutstandPreDispatchError` class: authorization/account discovery,
serialization and pre-request cancellation. These failures save a retryable
draft and permit another explicit attempt with the same `content_id`. Provider
POST timeouts, network errors and 5xx responses remain unconfirmed and are not
automatically replayed. An arbitrary error name or payload cannot claim that no
post was sent.

Suspended resources remain visible in discovery/history. Agent context and inbound
provider sync may still read raw settings; those reads do not authorize the covered
outgoing sends. Legacy top-level `channels.email`, `agent_email`, `whatsapp`, and
`agent_whatsapp` are intentionally not included in connection-row license quotas.
This change does not add license checks to unrelated provider-management/import
operations. Member authorization is separate from resource authorization:
bearer-user `canAccessSite` calls `site_user_has_effective_access(p_site_id,
p_user_id)` without positive membership caching. Internal and tenant-scoped
machine credentials retain their existing authorization contract.

An already accepted provider delivery is not revoked by this change. In particular,
Outstand scheduled posts/DMs accepted before expiration execute upstream; there
is no local final-delivery callback that can reauthorize or cancel them. Never
claim cancellation or exactly-once delivery, and inspect receipts before retries.

## Coordinated rollout

Deploy the market-fit trial migrations through
`20261019220004_startup_trial_resource_projection.sql`, then the forward repairs
`20261019233000_preserve_trial_renewal_rpc_contract.sql` and
`20261019233001_license_legacy_voice_statuses.sql` **before** enabling this API
revision against the shared database. The Voice repair counts `active`/`synced`
Voice connections against the same channel quota, suspends them when denied,
and retains their original status when capacity allows. Other channel types do
not gain these aliases. Only `service_role` may call the projection.
The same batch supplies the service-only `site_user_has_effective_access` RPC;
missing actor authorization fails closed, without raw ownership/member fallback.
No generated type update is needed: this API's existing Supabase service client
uses unparameterized RPC typing. Do not deploy an old worker that bypasses the
covered adapters. Deploy/build/migrations and live provider sends require separate
approval; none are performed by the offline tests.

## Offline validation

```bash
PATH=/opt/homebrew/bin:$PATH npm test -- --config jest.exact-delivery.config.mjs --runInBand
node node_modules/jest/bin/jest.js --config jest.transactional-email.config.js --runInBand
node node_modules/jest/bin/jest.js --config jest.outreach.config.mjs --runInBand
PATH=/opt/homebrew/bin:$PATH npm test -- --config jest.voice.config.js --runInBand --testMatch='**/ChannelSendService.test.ts'
PATH=/opt/homebrew/bin:$PATH npm test -- --config jest.voice.config.js --runInBand --runTestsByPath src/lib/services/zavu/__tests__/voice-license-statuses.test.ts src/lib/services/zavu/__tests__/voice-call-service.test.ts src/lib/services/zavu/__tests__/voice-call-lifecycle.test.ts
npm test -- --runInBand src/lib/integrations/outstand/__tests__/license-execution.test.ts src/lib/integrations/outstand/__tests__/conversations.test.ts src/lib/integrations/outstand/__tests__/client-comments.test.ts src/lib/services/workflow-robot/__tests__/channel-message-connection.test.ts src/app/api/agents/tools/publish/__tests__/social-publishing.test.ts
PATH=/opt/homebrew/bin:$PATH npm exec --offline -- tsc --noEmit --incremental false --pretty false
```

Mocks replace only database/provider I/O. Freshness tests exercise active admission,
expiration between preparation and send, missing RPC denial, malformed/duplicate
inventory, unrelated inactive drafts, caller cancellation even when transport
ignores abort, and expired provider-active social accounts with no provider POST.
Channel regressions cover two licensed Telegram senders, suspended-first fallback,
all-suspended denial, and expiry after audio preparation. Voice regressions use
the real service and license helper with mocked RPC/database/provider I/O to
cover legacy and exact `connected`/`active`/`synced` placement, projected expiry,
sender replacement, duplicate/inactive rows, and strict non-Voice statuses.