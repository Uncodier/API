# Support report: live voice tool callback missing its signature

**Subject:** Production voice tool callback has no usable X-Zavu-Signature; manual tool test authenticates successfully

Hello Zavu Support,

We need help tracing and fixing a production inbound voice tool invocation that
reached our webhook without a usable `X-Zavu-Signature` header. Our endpoint
rejected it with HTTP 401 before executing the tool. A manual tool test on the
same agent and webhook subsequently authenticated and completed successfully.

The issue remains unresolved. Our previous API patch added diagnostics; it did
not repair signing in the live-call path. All times below are UTC.

## Impact and identifiers

The affected call completed, but its recorded tool invocation failed. We have
not established that every tool or every voice call is affected.

| Field | Value |
| --- | --- |
| Provider call ID | `px7qtfhpkxr2ycrdawaskvkebs8fcyhx` |
| Provider agent ID | `q97fcnvg00dm5sq4fdbp28v4hh8eww75` |
| Provider sender ID | `kd710w4866q1x9fnkq4sjgymj18ettzb` |
| Failed tool turn | `2026-09-30T03:19:35.718Z` |
| Application request ID | `9922a0b8-aabf-4621-be4d-da7011680fbc` |
| Vercel request ID | `fd2k8-1790738374857-c239f62433dd` |
| Production deployment | `dpl_7rsrsrkFstFnpLA4hQdSb6zM3tYd` |

All 16 listed tools were enabled and targeted this HTTPS webhook when inspected:

```text
https://backend.makinari.com/api/integrations/zavu/voice-tools?siteId=9be0a6a2-5567-41bf-ad06-cb4014f0faf2
```

The failed transcript turn does not identify the tool name. Please resolve the
actual tool ID/name from the provider call trace; do not assume it was the
`skill_lookup` tool used for the successful control below.

## Shared secret configuration

Our synchronization code passes the **same agent-level secret to every managed
tool** as its `webhookSecret`. We do not intentionally use a different tool
secret for live voice and manual tests. Our receiver verifies tool callbacks
with that stored agent secret.

The generated signature changes with the request body; the shared secret is
not itself the signature. This report is about a missing/empty signature, not
a demonstrated mismatch between two secrets.

We understand that tool-list responses intentionally omit `webhookSecret`.
We have not interpreted that omission as evidence of missing provider-side
configuration, nor can those responses prove the current secret for every tool.
Call-lifecycle webhooks (`call.*`) are a separate integration surface; their
success does not establish that tool callbacks are signed correctly.

## Observed failure

The provider transcript records this response from our endpoint:

```json
{
  "http_status": 401,
  "http_body": {
    "code": "VOICE_TOOL_AUTH_FAILED",
    "error": "Invalid signature",
    "request_id": "9922a0b8-aabf-4621-be4d-da7011680fbc"
  }
}
```

The correlated application log reports:

```text
event: authentication_failed
reason: missing_signature
signature_format: missing
has_tool_header: false
has_timestamp_header: false
has_authorization_header: false
secret_configured: true
secret_decryptable: true
```

`missing_signature` means `X-Zavu-Signature` was absent, empty or whitespace-only.
Verification returned before computing any HMAC or validating a timestamp. No
tool was executed. Raw headers, signatures and request bodies were not logged.
This proves no usable signature reached our handler; it does not identify
which upstream component omitted or removed it.

## Successful controls on the same production endpoint

### 1. Provider-triggered manual tool test

```text
POST /v1/agents/q97fcnvg00dm5sq4fdbp28v4hh8eww75/tools/ps7fec1e6san5whj9dh7p46gjn8f0dzv/test
```

```json
{"testParams":{"action":"list","limit":1}}
```

- Tool: `skill_lookup` (read-only list operation).
- Test run ID: `qx7kjf6wj2qspfaa1jv6q4acdx8fczxp`.
- Recorded time: `2026-09-30T03:24:38.263Z`.
- Result: `run.success: true`, `run.statusCode: 200`.
- Application request: `50bdb551-adcb-49b2-8143-f32be0ead0f7`.
- Receiver log: `execution_completed`, tool `skill_lookup`, status 200.

This is a successful authenticated execution, not merely HTTP 200 from the
test API. It proves that this manual-test path works, not that the unknown
failed tool or the real voice runtime works.

### 2. Signed/unsigned no-tool controls

We sent the exact body `{"arguments":{}}` to the production webhook:

- Signed using HMAC-SHA256 over the raw body with the stored agent tool secret:
  HTTP 400 `Missing tool name`, after successful authentication. Application
  request: `0d98c9ad-6e13-486f-8406-331976ee4d17`.
- Same body without a signature: HTTP 401 `VOICE_TOOL_AUTH_FAILED`. Application
  request: `5fc39022-ccd8-4e9a-98b7-9b8e301ed4d6`.

Neither request executed a tool. Our middleware source and offline regression
tests preserve incoming Zavu headers and the exact raw body. These checks do
not substitute for inspecting the provider's actual outbound request.

## Investigation requested

Please compare the live-call path with the successful manual-test path:

1. Resolve the failed tool's ID/name and the voice runtime version handling
   the call above.
2. Confirm whether the configured tool signing secret was available to that
   runtime, using a boolean/configuration version rather than disclosing it.
3. Determine whether a nonempty `X-Zavu-Signature` was attached before dispatch
   and preserved through any intermediate voice transport/proxy.
4. Ensure the tool invocation signs the exact serialized HTTP body with its
   configured `webhookSecret` and sends the documented HMAC-SHA256 hex header.
5. If additional voice-specific configuration is required, provide the exact
   supported setting/API and documentation. We have found no documented
   exception allowing unsigned voice tool callbacks.

Please provide the identified cause, fix/deployment status and a validation
plan. No raw secrets, full signatures or caller data are needed in this ticket.
We have not rotated secrets or disabled authentication to mask the failure.

## Acceptance criteria

- A controlled real inbound call invokes a known read-only tool after the fix.
- Its callback arrives with a nonempty, valid signature and executes with HTTP
  200. Correlate the provider call/tool ID and our application request ID.
- Manual tool tests continue to work; unsigned and tampered requests remain
  rejected.
- Validate through the actual voice runtime, not only the manual-test endpoint.
  Coordinate the call with us; do not initiate unsolicited outbound calls or
  run write-capable tools against customer records.

## Documentation references

- [Webhook tools: payload, headers and signature verification](https://docs.zavu.dev/guides/ai-agents/tools)
- [Tool schema: secret is returned only at creation; every call is signed](https://docs.zavu.dev/api-reference/agent-tools/list-tools)
- [Tool tests: inspect run.success and statusCode, not just endpoint status](https://docs.zavu.dev/api-reference/agent-tools/test-tool)
