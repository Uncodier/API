# Customer Support channel guidance via Temporal

The Customer Support HTTP route no longer executes `channel_message` plans while
constructing the assistant command. The durable path is:

1. An authorized inbound request starts `customerSupportMessageWorkflow` on the
   `high` Temporal queue. Web requests receive HTTP 202 with the workflow ID;
   the browser polls the session-authorized status endpoint for the eventual
   conversation and reply.
2. The workflow asks the API to prepare matching triggers for that site's
   channel and message. Each run has a site/message/instance idempotency key.
3. Temporal advances at most two runs concurrently, one bounded model turn per
   `/api/workflows/channel-message/advance` request. The provider request has
   a 90-second timeout with zero automatic retries; interrupted turns fail
   closed instead of being replayed. Temporal stops waiting after four minutes
   and proceeds without guidance if needed.
4. The workflow passes **completed run IDs only** to the Customer Support API.
   The API verifies each run's site, inbound message ID, channel, enabled
   trigger, and completion status before adding bounded, untrusted guidance to
   the response context. Customer Support policies take precedence.

All prepare/advance/result endpoints require an authenticated internal service
principal; a browser cannot invoke them. Direct calls to the Customer Support
message API do not run channel plans inline and do not receive guidance unless
the trusted Temporal call supplies verified completed run IDs. Email deliveries
without a stable provider message ID also skip guidance; no ID is invented.

## Bounded turn accounting and recovery

Each provider turn checks the site's credits and charges reported input/output
tokens using the existing assistant pricing, including malformed or rejected
model results. Transaction metadata binds usage to the persisted site, instance,
run, step, inbound message, and attempt. Missing usage or unconfirmed deductions
fail closed and require billing reconciliation; they are not automatically
charged again. A completed cached run does not invoke or charge the provider.

Known retryable HTTP failures and rejected output persist `retry_count` and
return the step to `pending`. A later advance executes the next bounded turn
with the error and `recovery_plan` in its prompt. The existing workflow retry
semantics apply: after incrementing the count, retry only while it is less than
`max_retries` (default 2; values 0 or 1 allow no additional attempt). Failure
branches wait until retry exhaustion. Timeouts, interrupted in-progress turns,
and ambiguous provider outcomes are never replayed automatically.

The web send and status endpoints share a 4,000-character message limit and a
32 KiB JSON body limit. Their exact POST/OPTIONS paths defer visitor-session
authorization to the route; the internal channel-message APIs remain private.
Status responses distinguish a running workflow, a completed result, a terminal
workflow failure (422), and temporarily unavailable status (503).

## Rollout / validation

Deploy the API endpoints and Temporal worker that polls the `high` queue
together, then update the website widget. Do not enable an asynchronous web
entrypoint before the worker and status endpoint are available. Verify with a
real, disposable, session-authorized message on a nonproduction site; local
unit tests cannot prove the worker is running or provider calls succeed.

The legacy channel-message **Test** action is disabled until a bounded test
workflow is available. The ordinary workflow runner rejects pre-response runs
so no alternate HTTP path can execute those turns without a bound. Other
Customer Support model/command work still occurs in its existing API endpoint;
Temporal coordination does not remove that separate endpoint's time limit.