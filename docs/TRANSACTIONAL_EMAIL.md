# Transactional email: Zavu / SendGrid

The existing `SendGridService` / `sendGridService` names are retained as a
compatibility facade. Every current consumer of that facade (including Supabase
Auth, visitor verification, invitations, billing and notifications) selects its
transport through the server-only `TRANSACTIONAL_EMAIL_PROVIDER` variable.
System notifications also dispatch directly through this facade, not through
AgentMail first. Harness support preflight validates the selected provider's
configuration; a Zavu-only deployment does not require `SENDGRID_API_KEY`.
SMTP/AgentMail lead and conversation transports are not changed.

## Configuration

In the repository-root `.env.local`, or the deployment's secret/environment store:

```dotenv
TRANSACTIONAL_EMAIL_PROVIDER=zavu
TRANSACTIONAL_EMAIL_FROM_EMAIL=hi@makinari.email
TRANSACTIONAL_EMAIL_FROM_NAME=Makinari
```

Zavu also requires `ZAVUDEV_API_KEY`, plus `TRANSACTIONAL_EMAIL_ZAVU_SITE_ID` and
`TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID` pointing to the operator-owned site's
existing email connection. `TRANSACTIONAL_EMAIL_ZAVU_SENDER_ID` is an optional
additional pin against replacing that connection's sender. Keep credentials in
the private environment store; never commit `.env.local`.

The resolver requires exactly one matching connection, type `email`, status
`connected`, and the configured address. Before dispatch, it reads the live
sender and domain from Zavu, checking email activation, matching IDs/address and
verified domain. Caller `from`, `siteId` or custom metadata cannot select a
different sender. Sending does not require changing MX or enabling reception.
The sender's existing configured display name is used; the environment name
documents the expected Zavu display name, not a per-message mutation of the sender.

## Switching back

Set `TRANSACTIONAL_EMAIL_PROVIDER=sendgrid`, retain `SENDGRID_API_KEY`, and restart
the application/redeploy. An omitted provider defaults to SendGrid; an invalid
value fails closed. SendGrid preserves its historical per-call `from` overrides
and `SENDGRID_FROM_*` defaults, ignoring the Zavu address variables. Changing
the provider alone restores that existing configuration; no additional sender
verification or clearing Zavu variables is required.

Updating a local env file does not update Vercel/other deployed environments.
There is no automatic provider fallback: a timeout may mean the provider already
accepted the message, so sending via another provider could duplicate it.

## Contract and differences

- Zavu receives `channel=email`, `Zavu-Sender`, subject, HTML and plain text.
  HTML-only callers get a text fallback with link targets preserved.
- `replyTo`, categories/custom arguments as metadata, and base64 attachments
  are supported. MIME type/CID are mapped to `content_type`/`content_id`.
  Inline attachments require a CID; limits are 50 files and 40 MiB total.
- CC/BCC, SendGrid dynamic templates and scheduled `sendAt` fail before any
  Zavu dispatch instead of being silently dropped. They remain available with
  the SendGrid provider.
- Recipient arrays are deduplicated and dispatched individually; inspect
  `recipientResults` for partial success. A batch has no fabricated message ID.
- `success` means accepted (`queued`, `sending`, `sent`, `delivered`, `read`),
  **not inbox delivery**. Unknown states/missing IDs are not success.
- Zavu HTTP 409 idempotency responses replay the existing message. Only message
  POSTs with an idempotency key accept this replay; other 409s still fail.
- Supply a stable server-side `idempotencyKey` to retry a logical operation.
  The outgoing key binds that operation to sender, recipient and content.
  Without one, each call is a new operation. There are no automatic retries.
- The Auth hook derives a hashed identity from its verified webhook event and
  auth payload. Both secure-email-change sends share a four-second overall hook
  deadline. Locale lookups have a 500ms budget and default to English if stalled;
  their queries receive cancellation. A stalled provider/body read is also
  bounded. SendGrid requests already accepted/in flight cannot be canceled by
  its SDK; a timeout is uncertain and never triggers a fallback or retry.
  Keys/logs/metadata do not expose OTPs or confirmation tokens.

## Operational limitations

This transport migration introduces no SQL migrations or new outbound queue.
The existing Zavu webhook admission records are durable, but email lifecycle
events are still logged, not materialized as per-email delivery receipts.
Reconcile delivery in Zavu using returned message IDs. General notification
caller retries without a stable key are not deduplicated automatically.

Keep transactional traffic isolated from cold outreach. Zavu can hold messages
for risk review or suspend sending; a separate sender alone does not prove
account/project isolation. Monitor balance, bounce rate, latency and delivery,
especially OTP expiration, before removing the backup provider.

## Validation

`npm run test:transactional-email` runs offline mocked transport, sender binding,
provider compatibility, replay, batch/error and signed Auth-hook tests. It does
not load `.env.local`, contact providers or send real email.

References:
- [Zavu message contract](https://docs.zavu.dev/api-reference/send-a-message)
- [Zavu email setup](https://docs.zavu.dev/guides/email/setup)
- [Supabase Auth hooks and deadlines](https://supabase.com/docs/guides/auth/auth-hooks)
