# Zavu inbound voice lead linkage

## Boundary and purpose

The authenticated `POST /api/integrations/zavu/webhook` voice lifecycle now
records a CRM lead independently of assistant response generation and transcript
projection. This closes the gap left when `queueInboundVoiceResponse` was
removed in `7b54ce13` and replaced with `persistVoiceTranscript`.

Only terminal inbound events (`call.completed` / `call.failed`) create a
minimal contact. Nonterminal events may look up an existing contact for private
continuity, but do not create a new contact or start another assistant.
Outbound calls retain their existing lead/consent requirements.

The webhook still verifies the raw-body Zavu signature and acquires the durable
provider event claim before business processing. Sender configuration resolves
the site; the provider-fetched call supplies the caller phone. A mismatched
provider call ID or ambiguous sender-to-site mapping is rejected. Transcript
text, model/tool output and arbitrary event `site_id`/`lead_id` fields are not
identity authority.

## Lead resolution

`src/lib/services/zavu/inbound-voice-lead.ts`:

1. Validates site UUID and full E.164 caller phone. Normalization removes only
   formatting and converts a `00` international prefix; it does not guess a
   country, discard trunk digits, or match the last ten digits.
2. Looks up candidates within the same site, then compares the entire normalized
   phone. Ambiguous matches or a truncated candidate set require human review;
   no `limit(1)` identity merge is performed.
3. Reuses a unique existing lead without modifying its name, email, phone,
   metadata, status, opt-outs or consent.
4. If absent, resolves the active site's owner and inserts a minimal lead with
   `origin: voice`, `status: contacted`, a descriptive `Voice caller <phone>`
   label and metadata explicitly marking identity **unverified**. No name/email
   is invented from speech and no outbound-call consent is granted.

The deterministic `zavu-voice-lead:<site>:<phone>` UUID namespace is shared with
the native live `IDENTIFY_LEAD` adapter. Concurrent/repeated voice creations
therefore converge through primary-key uniqueness without an overwriting
upsert. A duplicate-key response must resolve to a valid same-site phone match
before it is treated as success.

This is not cross-channel phone uniqueness: unrelated writers can still insert
different IDs for the same number. The resolver fails on duplicates rather than
guessing which person owns a phone. Existing legacy formats that require country
or historical prefix inference need explicit reconciliation.

## Linkage and retries

Before transcript projection, the webhook validates the conversation, delivery,
provider call and lead relationship. It fills only null `lead_id` values on:

- the site-scoped inbound conversation;
- the matching site/conversation/provider-call delivery;
- existing messages in that conversation bearing the same provider call ID.

It never reassigns a non-null link or changes message text. Conversation and
delivery links are reread after conditional updates so competing changes cause
a visible failure, not a false successful association. Unrelated chat messages
and other calls are not bulk backfilled.

New transcript turns inherit the resolved lead. Historical transcript rows
ignored by `upsert(ignoreDuplicates: true)` are repaired by the null-only link
step. Thus replay of a failed persistence step retains earlier correct work and
does not duplicate leads, calls or turns.

The multi-table writes are individually retryable, not one database transaction.
A partial database failure propagates to the webhook, marks its durable claim
failed and allows provider retry. A conflicting non-null link requires human
review; a retry never overwrites it.

## Consent and identification

Recording an inbound CRM contact is not proof of the caller's identity and is
not permission for marketing or outbound calling. New leads explicitly retain
`voice_call_consent_status: unknown`; the consent timestamp is not populated.
Existing consent and do-not-call fields are never cleared or changed.

The live `IDENTIFY_LEAD` tool remains a separate consent-gated interaction for
confirmed caller attributes. This patch does not change its required fields,
relax callback authentication, or overwrite an existing profile based on
unverified attributes. A missing Zavu tool signature remains an independent
provider-runtime problem.

## Rollout and historic records

This is a local API code change; no schema migration is required. Deploy only
reviewed changes. No deployment, provider call or remote data repair was run as
part of implementation.

Future terminal inbound events apply the new behavior. A later **new** terminal
event for an existing null-linked delivery also reconciles it. Events whose
durable claims are already completed are intentionally short-circuited: merely
deploying or resending the same completed event does not repair old rows.

Repair of a historical conversation requires a separately authorized, targeted
reconciliation using trusted provider-call/site data. Do not reset all webhook
claims, replay the old Customer Support workflow, initiate another call, or grant
consent to force recovery.

## Offline validation

Run from the API repository:

```sh
npm run test:voice -- --no-cache
```

The suite includes the actual signed webhook → lifecycle → lead resolver →
conversation/delivery → transcript flow with isolated provider/database doubles,
plus formatted phone reuse, new contacts, cross-site denial, unsigned webhook
denial, duplicate events, concurrent creation, partial failure retries,
conflicting linkage and legacy null-link recovery. No live provider calls are
used as regression tests.

Validation: 265 tests passed in 23 voice suites, including the split inbound
message and voice webhook regression suites. `git diff --check` passed.
Whole-repository TypeScript still reports the same 203 baseline diagnostics;
there are no new diagnostics and none in the changed voice files. The existing
API lint script invokes removed `next lint`, so it is not claimed as a passing
ESLint check. No build was run.