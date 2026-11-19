# Assistant failure recovery

The durable `processAssistantTurn` step keeps `maxRetries = 0`. Replaying a whole
turn can duplicate tools, outbound messages, publications, or paid operations.

When the shared core rejects with a recognized transient admission HTTP error or
confirmed DNS/refused-connection error, the settled wrapper may release its turn. This is
allowed only for the current trusted action/generation, with an unchanged node
binding, a saved conversation, a single-output execution, and an explicitly empty
tool-observation list. Node turns are excluded because response-node writes can
occur outside tool execution. Missing observations, any attempted tool (even one
that returned or threw), plan execution, cancelled actions, and ownership conflicts
fail closed. In-process requirement hosts retain their own failure semantics.

A released failure crosses the Workflow boundary as data rather than an exception,
so the engine cannot hide the recovery decision inside a `FatalError`. The workflow
claims and starts the existing silent continuation using the original execution
configuration and saved conversation. Existing atomic leases and the five-respawn
limit apply. Ambiguous workflow admission retains its lease; an old generation must
not mark that continuation failed.

Generation identity, usage, accepted-stream markers, billing errors, timeouts and
connection resets block automatic inference retry. All nested causes are checked
before accepting an outer transient status. Customer-provider rejected dispatches
retain only a sanitized transient code and numeric deadline, not provider secrets.

`Retry-After` seconds and HTTP dates become a durable `retryNotBefore` checkpoint
and a Workflow timer. Neither the workflow nor maintenance may claim recovery
before that deadline. Missing headers use a one-second minimum backoff. Invalid
headers or waits exceeding 24 hours fail closed; requested waits are never shortened.
Cancellation and ownership are rechecked after waiting.

Unrecoverable errors produce a generic public failure message and a failed outcome,
not a raw exception or internal path. The instance error log stores a bounded,
credential-redacted diagnostic in `details.error`; diagnostic details are not
public message text. Log APIs must continue to enforce their existing authorization.
If failure persistence itself fails, the workflow throws a sanitized operational
error rather than reporting a normal completion with an unpersisted failed state.

This does not automatically replay tools or immediately recover engine-level
timeouts/process termination, unknown application errors, or any turn with tool
effects. Existing stale-turn recovery remains separate. Changing retry counts
alone is not a substitute for effect reconciliation.

## Recovery-control interruptions

The settled turn wrapper also carries trusted `RecoveryError` decisions as
sanitized data. Workflow reconstructs thrown step failures as `FatalError`, so
checking the original error name only in the workflow catch is not sufficient.
Without this envelope, a temporary checkpoint outage after a tool effect could
incorrectly mark the user action `failed` and exclude it from stale recovery.

These interruptions return a paused workflow outcome without inserting a public
failure log, completing/pausing/failing the trusted action, releasing the in-flight
turn, overwriting its transcript, or replaying tools. Eligible running conversations
remain discoverable by the existing 15-minute stale-turn recovery and retain their
uncertain tool observations. This is not an immediate retry or a guarantee of
continuation: cancellation, superseding input, node/plan exclusions, ownership,
admission ambiguity and recovery limits still apply. In-process requirement hosts
and plan-step reconciliation keep their existing error semantics.

The offline `recovery-failure-boundary` regression models the SDK's JSON-result /
`FatalError` boundary with real recovery storage logic. It covers an accepted
effect followed by a persistence outage, recovery before the ownership check,
refusal before the inactivity deadline, and eventual agent continuation with
unknown-outcome evidence rather than an invented receipt. The existing build
suite separately compiles the workflow with the real SDK plugins.

Offline validation:

```sh
npm run test:assistant-runtime
```

The suites cover transient classification, safe release and refusal, silent
continuation, ambiguous admission, terminal message sanitization, credentials,
ownership/cancellation fences, and compilation with the real Workflow plugins.