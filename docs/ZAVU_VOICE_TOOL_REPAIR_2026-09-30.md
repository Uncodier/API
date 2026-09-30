# Voice tool incident: 2026-09-30

## Verified incident

- Conversation: `3aafe97b-bd06-59b8-85c6-88a0c0ac39f3`.
- Provider call: `px7zy0bdtz04q7hfxg3738qnyn8fcnxc`.
- Site: `9be0a6a2-5567-41bf-ad06-cb4014f0faf2`.
- Provider agent: `q97fcnvg00dm5sq4fdbp28v4hh8eww75`.
- Provider sender: `kd710w4866q1x9fnkq4sjgymj18ettzb`.
- Two tool responses at `2026-09-30T02:19:37.083Z` and
  `2026-09-30T02:19:52.345Z`: HTTP 401, `Invalid signature`.
- Provider call transcript and persisted delivery agree. The provider does not
  include the failed tool names or original HTTP headers in these turns.
- Sender/agent association, enabled voice, and all 16 tool webhook URLs were
  correct when inspected. No sender or secret configuration was changed.
- Vercel request IDs: `gwdj4-1790734776829-a2cf4f230309` and
  `jrjr8-1790734792088-829bf7c3e7f9`. Both reached the route and failed signature
  verification. The logs do not contain enough information to reconstruct the
  original signature. User-agent identification is not authentication.

## Repairs in this patch

1. A voice-only `IDENTIFY_LEAD` contract and native adapter replace the browser
   visitor endpoint. The old endpoint expects `visitor_id` and `site_id`, which
   are not inputs of the advertised voice tool. The new adapter validates
   explicit `consent: true`, confirmed contact data and caller phone from the
   authenticated callback; it creates/reuses a site-scoped lead and returns `lead_id` without
   fabricating a visitor or requiring an already-materialized conversation.
   Existing profiles and outbound-call opt-outs/consent are not overwritten.
   Caller ID is not independent proof of a person's identity. Existing legacy
   phone formatting is not automatically merged. Deterministic IDs deduplicate
   native voice retries, but do not impose cross-channel phone uniqueness on
   unrelated writers (the database currently has no such unique constraint).
2. Failed HTTP tool turns produce generic system diagnostics in conversation
   messages. Tool bodies, secrets and contact data are not copied into these
   diagnostics. Successful/private tool outputs remain hidden; full transcripts
   remain in `voice_call_deliveries.transcript`.
3. The webhook emits structured diagnostics and `x-request-id`. Signature checks
   distinguish missing header, missing/decryption-failed secret, unsupported or
   malformed format, expired/future timestamp and digest mismatch. No body,
   secret, signature, authorization value or raw execution error is logged by
   this diagnostic path. Public authentication errors remain generic. Safe
   transcript messages retain a validated request UUID for log correlation.

## Authentication is not yet proven repaired

The HMAC policy has **not** been relaxed. There is no unsigned fallback, static
secret in a URL, user-agent allowlist or acceptance of model-provided tenant
identity. Supported raw-body legacy hex and timestamped v1/v2 verification
remain fail-closed.

During diagnosis, a locally signed no-tool request passed production HMAC
verification, and provider manual tool tests passed it too. `skill_lookup`
returned HTTP 200. Intentionally incomplete inputs for `scheduling`,
`reservations` and `IDENTIFY_LEAD` reached business validation (HTTP 422), without
creating contacts or appointments. These tests do **not** prove the real voice
runtime uses the same signing path. The original voice 401 needs a fresh
callback with the new diagnostics, or the original provider request headers.

## Rollout / validation

This patch is local until deployed. Do not deploy unrelated working-tree work.

1. Run `npm run test:voice` from the API repository. This is the offline CommonJS
   voice suite; unrelated email tests using `jest.unstable_mockModule` must run
   separately under the existing ESM Jest configuration.
2. Deploy the reviewed repair using the normal deployment process.
3. Re-sync the affected site's voice agent/tools using the existing authorized
   `PATCH /api/integrations/zavu/voice` endpoint with
   `{ "siteId": "9be0a6a2-5567-41bf-ad06-cb4014f0faf2" }`.
   This endpoint requires a site owner/admin session. Synchronization is needed
   to advertise the new required `consent` input and update the voice prompt.
   Do not infer consent for older tool definitions or old recorded calls.
4. Run a provider manual `skill_lookup` test with `action: "list", limit: 1`.
   Use the agent-scoped `/v1/agents/{agentId}/tools/{toolId}/test` route for this
   standalone agent; the legacy sender-scoped route returned `Agent not found`.
5. Make a consented real inbound test call. Check `[Zavu Voice Tool]` logs for
   `authentication_failed`, its safe `reason` and `signature_format`. Correlate
   the returned request ID and call time with the provider. Never print or
   share stored secrets or full signed requests in tickets.
6. If authentication succeeds, verify native lead identification and use the
   returned `lead_id` for subsequent scheduling. An inbound call alone does
   not grant outbound-call consent.

The transcript projection change applies on the next transcript persistence;
it does not automatically rewrite historic conversations. The original errors
remain available on the delivery. Zavu's tool test-run and agent execution lists
are not logs of real voice tool executions.

## Local verification

- `npm run test:voice`: 17 suites, 197 tests passed.
- The three existing email ESM suites were checked separately with the existing
  `jest.config.js` and `--experimental-vm-modules`: 24 tests passed.
- `git diff --check`: passed.
- Whole-repository `tsc --noEmit --incremental false` still reports 158
  diagnostics outside the edited voice modules; no voice-module diagnostics.
  This is not a clean project-wide build or an end-to-end real-call test.

## References

- [Zavu webhook tools](https://docs.zavu.dev/guides/ai-agents/tools)
- [Tool tests and side effects](https://docs.zavu.dev/api-reference/agent-tools/test-tool)
- [Manual test-run scope](https://docs.zavu.dev/api-reference/agent-tools/list-tool-test-runs)
- [Voice calls and transcripts](https://docs.zavu.dev/guides/voice-agents/overview)