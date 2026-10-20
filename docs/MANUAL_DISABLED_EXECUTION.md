# Manual-disabled connection execution guards

## Contract

This API consumes the shared database's service-only
`get_site_licensed_resources(p_site_id)` projection. It does not own or alter the
manual-disable database migration. Deploy the shared projection repair before
these API guards. A manually disabled connection is expected to project disabled
status/`enabled: false` and protected `_license.manually_disabled: true`.

`src/lib/billing/licensed-resources.ts` independently rejects the protected marker,
even when a connection remains provider-connected and quota-licensed. The check
does not change social-account licenses or tenant/member authorization. Missing
or malformed projection remains fail-closed; no raw-settings authorization fallback
or license cache is introduced.

## Execution boundaries

- Generic Zavu channel selection skips manually disabled connections. The exact
  selected ID/sender is rechecked after audio preparation, before provider send.
- Exact delivery/outreach selection excludes the marker. Existing fresh checks in
  exact delivery and prepared outreach closures deny late disable before dispatch.
- Tracked Voice selection uses the same predicate; existing final placement checks
  deny disable after contact preparation.
- Transactional Zavu email's existing per-recipient check stops new recipients
  after disable. Already accepted recipients are not replayed or revoked.
- Actual Zavu inbound text entry is `src/lib/services/zavu/webhook-handlers.ts`.
  Uncached sender mapping must identify one site and one channel connection. Live
  projection admission precedes the Customer Support workflow. The workflow carries
  pinned connection/sender metadata. The Customer Support route checks it again
  before preparation and after context preparation, before submitting an agent command.
- Denied trusted text ingestion saves user-only conversation/message history with
  deterministic IDs and ignore-duplicate upserts. It never guesses a lead, adds an
  assistant message, starts workflows, or dispatches a provider response. Projection
  outages retain safe history and propagate retryable failure. Persistence errors
  propagate instead of silently losing history.
- Live Voice tools are `src/app/api/integrations/zavu/voice-tools/route.ts` and
  `src/lib/services/zavu/voice-tool-executor.ts`. All catalog tools, including
  `IDENTIFY_LEAD`, `get_call_context`, and `CONTACT_HUMAN`, require fresh projection
  admission and refresh pinned connections before execution. Signature validation
  remains separate and precedes execution. Resource denial returns safe 403/503 DTOs.
- Channel workflow prepare never interprets an unresolved external connection as a
  wildcard match. Stored null-connection external runs cannot advance or contribute
  completed guidance. Web chat still supports connectionless wildcard workflows.
  Voice persisted sender binding and exact stored destinations remain authoritative.

## Deliberate limitations

- Zavu's signed tool callback contract does not identify the connection/sender.
  Admission therefore conservatively requires **all configured sender-bearing Voice
  connections** to be licensed/enabled. Mixed enabled/disabled senders deny callbacks
  for the site; one enabled sender cannot authorize another disabled sender. This can
  also deny tools for a disconnected configured sender. A future trusted sender/call
  binding is needed to allow per-connection callbacks without collateral denial.
- Provider-native Voice speech can continue without calling local tools. These guards
  neither detach upstream Voice agents nor hang up existing calls. Voice lifecycle
  ingestion and transcript/lead history continue independently.
- Already accepted provider sends/calls are not cancelled. License reads and provider
  mutations are not atomic: disable after the last check cannot revoke that mutation.
  Already-running agent commands and workflow steps are not forcibly interrupted.
- Old Temporal jobs that lack the new pinned Zavu metadata are not retroactively
  upgraded. Coordinated worker rollout must preserve `custom_data`; the worker is
  outside this repository. Covered outbound adapters still deny disabled dispatch.
- Without a persisted exact sender identity, multi-connection channel workflow
  resolution now denies rather than selecting the only enabled connection. This
  protects against incoming messages from the disabled sibling but reduces automation
  availability until the worker persists exact identity.
- Legacy top-level email/AgentMail/WhatsApp configurations outside `connections` are
  not governed by connection manual-disable markers. Unrelated inbound/provider
  management/import paths are not claimed as covered by these focused guards.
- Denied text history is isolated by site/channel/sender/contact, not merged into an
  arbitrary prior lead conversation. Missing owner/provider message ID, ambiguous
  site/connection mapping, and Voice text echoes are not persisted through this helper.
  These cases deliberately avoid unsafe tenant attribution or duplicate generation.

## Offline verification

Run `node node_modules/jest/bin/jest.js --config jest.manual-disabled.config.js --runInBand`.
Existing `jest.voice.config.js`, `jest.exact-delivery.config.mjs`,
`jest.transactional-email.config.js`, and `jest.outreach.config.mjs` cover the
companion transport regressions. Use the repository's ESM Jest invocation for
existing workflow connection/boundary suites (`NODE_OPTIONS=--experimental-vm-modules`).
Mocks replace database/provider I/O only; no paid calls, build, deployment, remote
migration, or commit is needed. The previously oversized Voice executor test has
been split into executor and live-binding suites below the 500-line limit.