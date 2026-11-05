# Zavu channel activation

## Provider contract

Connecting an account and activating its channel are separate operations. Accounts
outside Zavu's included allowance can start inactive. The provider's
[activation endpoint](https://docs.zavu.dev/api-reference/senders/activate-a-sender-channel)
supports WhatsApp, Messenger, Instagram, Telegram, and email. Activation can incur
the provider's channel fees; an already-active channel is not charged again.

`ensureSenderChannelActive` checks the current sender first, then activates only
if needed. Success requires the expected sender ID and channel in `sender.channels`.
Timeouts or incomplete responses are not success. A retry reads provider state
again, so an activation that succeeded remotely but timed out locally can recover.

## Setup and recovery

- WhatsApp and Messenger: signed invitation webhooks and manager-authorized status
  polling fetch the current invitation from Zavu, persist the sender as pending,
  configure its webhook/signing secret, and activate before reporting connected.
  Finalization failures return an error, not a completed invitation.
- Telegram: setup persists the sender before connecting/activating, so retrying
  the same channel reuses it. Provider activation must succeed before connected.
- Email: sender setup activates when its matching domain is verified. DNS
  verification, channel activation, and receiving remain separate states.
- Instagram: activation/recovery works for an already persisted, sender-backed
  Instagram connection. Zavu's partner invitation API supports only
  `whatsapp_waba` and `messenger`; this change does not add Instagram onboarding.
- SMS and Voice do **not** use the account activation endpoint. SMS uses sender
  configuration and number capability; Voice uses its existing agent/sender and
  regulatory workflow. Do not call `/channels/sms/activate` or `/channels/voice/activate`.

The web application exposes explicit activation recovery for existing linked
social/Telegram accounts, including legacy connected rows without confirmation.
It warns about Zavu fees and does not bulk-activate historical accounts on page load.
New setup completion performs activation as part of the requested connection.

## Boundaries and persistence

`POST /api/integrations/zavu/senders/[id]/channels/[channel]/activate` requires
`{ siteId, channelId }`, authenticates a site manager, and verifies persisted
channel type/sender ownership. The static email endpoint remains compatible.
Invitation GET/DELETE now require a `siteId` query parameter and manager access;
the invitation must belong to that site. Deploy the API and web changes together.

Activation updates use existing-only compare-and-swap writes, preserving concurrent
settings changes and refusing deleted, replaced, disabled, or suspended channels.
The returned connection comes from the database, not a pre-trigger synthesized row.
Live license projection and shared account capacity are checked before provider activation.
Pending connections do not reserve plan capacity: the existing database admission rules still own
final connected-state admission. There is no distributed transaction between Zavu
and the database; a concurrent entitlement change or database failure after a
provider charge can leave the provider active while local setup remains pending.
Retry/reconciliation is required; this change does not automatically refund or
deactivate provider accounts in that case.

Provider failures preserve sender identity and pending activation, without storing
provider error bodies or exposing webhook secrets. Manual-disable and license
suspension are not cleared by activation recovery.
Missing webhook-secret initialization uses the existing durable provider-event
claim RPCs to serialize webhook/polling workers. Those RPCs must already be
deployed (they are also required by the current webhook receiver).
An ambiguous webhook-secret rotation is held for reconciliation, not automatically
repeated: aborting a timed-out request does not prove that the provider cancelled it.

## Offline validation

```sh
npm test -- --config jest.zavu-activation.config.js --runInBand
npm test -- --runInBand --runTestsByPath \
  src/app/api/integrations/zavu/channels/telegram/__tests__/route.test.ts \
  src/app/api/integrations/zavu/channels/email/__tests__/route.test.ts \
  'src/app/api/integrations/zavu/senders/[id]/channels/email/activate/__tests__/route.test.ts'
```

The second command uses the existing ESM test fixtures; the focused activation
configuration uses CommonJS mocks. No test contacts Zavu or applies remote migrations.
Deploy and perform a separately authorized provider canary before claiming live
activation success. No schema migration is introduced by this change.