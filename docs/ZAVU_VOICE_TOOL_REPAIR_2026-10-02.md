# Voice tool validation and live context repair

## Incident and scope

The inbound call associated with conversation
`0543c39c-51c3-5caa-8a4b-60509306c8de` recorded four failed callbacks on
2026-10-02 (UTC): scheduling at 00:10:14, identification at 00:10:51 and
00:11:24, and human assistance at 00:11:41. Vercel and the provider transcript
agree on HTTP 422; PostgreSQL also recorded the final invalid UUID input.
Unlike the September signature incident, these callbacks authenticated.

The recorded errors identify invalid optional contact fields and an invalid
scheduling context, but do not preserve the original arguments. Null/blank
optional arguments are a reproduced failure mode, not a claim about the exact
original payload. The final human-assistance failure explicitly used `unknown`
as a lead UUID.

## Repair

- Native identification treats null/blank **optional** phone, callback phone,
  and company values as absent. Wrong types, nonempty invalid values, caller
  phone mismatches, missing required details, and missing explicit consent
  remain errors. No country code, email, name, or consent is inferred.
- Authenticated inbound initiation/answer events persist a minimal unverified
  contact and deterministic conversation/message/delivery immediately. Final
  transcript persistence still happens at termination. Retries use the same
  IDs; existing profiles and non-null links are not overwritten.
  Ambiguous CRM matches preserve the call with a null lead and generic guidance
  for human review; no arbitrary profile is selected. Database failures are not
  swallowed as identity ambiguity.
- Scheduling availability no longer requires lead identity or accepts empty
  aliases as a reason to fail. Caller appointment listing and booking remain
  lead-scoped; no unfiltered listing is used as a fallback. Invalid supplied
  UUIDs are rejected before PostgreSQL with actionable validation guidance.
- Tool lead lookup uses the same full-phone alias matching and ambiguity
  rejection as inbound linkage, rather than exact raw phone equality.
- Voice human assistance no longer requires the model to supply a conversation
  UUID or successful identification. The server selects the unique active
  delivery for the signed caller and authenticated site and verifies its active
  state and caller against the provider with a bounded lookup (also checking the
  sender when the provider supplies it). Missing/ambiguous
  context fails closed; historical conversations are not selected arbitrarily.
- The contact-human backend validates the supplied delivery binding. This also
  handles outbound voice calls attached to an existing chat conversation without
  triggering a caller email/WhatsApp fallback. It returns pending only after a
  support task or team notification is accepted; no accepted work means failure.
  The voice model receives a compact result, not internal staff email addresses.
  The internal delivery marker requires the actual service credential. A slow
  team notifier is awaited for at most two seconds and continued with Next
  `after`; only confirmed work, including a persisted task, permits success.
- Provider descriptions and runtime instructions explain omission of optional
  fields and that human assistance is a pending request, not a live transfer or
  guaranteed callback. The separate chat tool contract is unchanged.

## Rollout and acceptance

This repair requires an API deployment **and** a voice-agent/tool re-sync. Local
tests do not establish deployment or real-call success. Do not deploy unrelated
working-tree changes with this repair.

1. Run `npm run test:voice` in `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`.
   The suite is offline and includes the voice contact-human route tests.
2. Deploy only reviewed repair files through the normal release process.
3. Re-sync the affected site's agent using the existing owner/admin-authorized
   `PATCH /api/integrations/zavu/voice` endpoint. Confirm `CONTACT_HUMAN` requires
   only summary, message, and priority, not model-generated identity IDs.
4. In a consented real inbound test, verify context exists before the first
   tool. Confirm identification with omitted optional details, scoped scheduling,
   and human assistance after a deliberate identification validation failure.
5. Check correlated request IDs in `[Zavu Voice Tool]` logs. Unsigned/tampered
   callbacks must still return 401. Do not disclose secrets or raw caller data
   when collecting evidence.

No live calls, customer notifications, historical contact edits, signature-policy
changes, or automatic provider re-sync are part of the offline repair tests.

## Operational limits

- If a terminal webhook is lost, an old active delivery can still block a new
  inbound delivery under the existing unique active-recipient index. Provider
  verification prevents routing human assistance to that old call, but it does
  not automatically reconcile or delete the stale record.
- Optional contact guidance is not serialized with terminal cleanup; concurrent
  early/terminal callbacks can race. It remains unverified context, never the
  authority used for contact consent or human-assistance call selection.
- This change does not redesign all appointment-update authorization or the
  pre-existing non-voice contact-human endpoint.

## Local verification

- The shared working tree passed `npm run test:voice`: 34 suites, 754 tests.
  This includes concurrent voice-context work; not every change in that tree is
  part of this incident repair.
- Regression coverage includes signed real POST/executor/identity flows with
  mocked external HTTP, null optional inputs, failed identification followed by
  assistance, ambiguous profiles, foreign scope, stale provider calls, forged
  service credentials, slow notifications and early-to-terminal persistence.
- `git diff --check` passed. No production rollout or real-call acceptance is
  implied by these offline results.
- Project-wide `tsc --noEmit --incremental false` still reports 204 diagnostics
  outside the repair-owned changes, including a nullable `preferred.data` in
  concurrently edited `voice-follow-up-context.ts`. There is no clean full-project
  typecheck/build claim; the final check reports no repair-owned diagnostics.