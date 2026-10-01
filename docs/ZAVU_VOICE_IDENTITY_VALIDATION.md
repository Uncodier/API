# Zavu Voice identity validation

## Incident and scope

Conversation `9a87d946-3d36-53cf-981f-8ed9fca4e883` failed three
`IDENTIFY_LEAD` callbacks with HTTP 422 on 2026-10-01. The transcript contains a
spoken email with `punto`, `arroba`, and `m e`. The old Zod schema accepted only
canonical email text and returned one generic error for all contact fields.
Neither the provider transcript nor application logs retained the failed tool
arguments, so the exact invalid field in those requests cannot be established.

## Current contract

- `name`, `email`, and boolean `consent=true` are required. Consent must be
  explicitly obtained; an inbound call is not consent.
- The agent reads back and confirms the complete email before saving. The
  server normalizes explicit Spanish/English separator words, single-character
  spelling, and harmless spacing/punctuation, then validates the result with
  Zod. It does not guess domains, fix spelling, or extract emails from prose.
- `phone` is optional. If supplied, it must match the authenticated callback's
  calling number. No caller identity is taken from model-supplied identifiers.
- `callback_phone` is an optional, confirmed international contact number.
  It is stored under `metadata.voice_identification` with
  `callback_phone_verified=false`. It never replaces `leads.phone`, participates
  in matching, merges a lead, or grants outbound-call consent. Local numbers
  require clarification of the country code, not country inference.
- HTTP 422 responses expose fixed codes and `invalid_fields`. Logs include
  those codes/field names and the correlation ID, not contact values. The agent
  corrects only the reported fields instead of repeatedly blaming the email.
- Successful responses include `lead_id`, `is_new_lead`, and
  `contact_details_saved`. A matched established profile is not overwritten;
  `contact_details_saved=false` explicitly means the agent must not claim the
  supplied details were saved and should seek human assistance for updates.

## Provisional inbound contacts

Only the empty placeholder created by `resolveInboundVoiceLead` may be completed:
the deterministic site/calling-number ID, generated name, voice origin, null
email, empty company (null or the live schema's default `{}`), and original
unverified webhook metadata must all match. Updates
are scoped to the site and calling number and compare the existing name, null
fields, and complete metadata snapshot before writing. Concurrent changes are
re-read or reported, never overwritten. Existing email/phone conflicts still
fail closed. Status, do-not-call settings, and outbound-call permissions remain
unchanged. Caller-confirmed details are not verified identity.

The update compares one row atomically and rechecks identity conflicts before
reporting success. As with the existing creation path, these application-level
checks are not a database-wide email uniqueness guarantee across independent
writers. Ambiguous profiles require human review; no automatic merge or global
uniqueness migration is introduced here.

## Activation

1. Deploy the API changes.
2. Re-sync the affected site's Voice agent using the existing authenticated
   `PATCH /api/integrations/zavu/voice` endpoint with `{ "siteId": "<site UUID>" }`
   (or the existing Voice synchronization UI). This updates both the provider
   tool schema and runtime prompt. Deploying alone does not replace the prompt
   already stored at Zavu.
3. Test a consented call with a spoken email, read-back confirmation, and an
   alternate contact number. Confirm the saved email and original calling number.

No historic contact data is backfilled by this change. No live calls, production
mutations, or agent re-syncs are performed by the offline test suite.

## Verification

Run `npm run test:voice`. Regression coverage includes email normalization and
rejection, field-specific errors, consent, tenant boundaries, literal email
matching, alternate phones, provisional contact completion, concurrent retries,
and preservation of existing profiles and opt-outs.