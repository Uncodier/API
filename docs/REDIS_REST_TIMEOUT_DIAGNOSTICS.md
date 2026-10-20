# Redis REST timeout diagnostics

The `[Upstash REST]` log prefix identifies the API's REST adapter, not necessarily
the hosting provider. Its configured endpoint may be an Upstash-compatible bridge
to Azure Redis. This adapter has a two-second deadline per command, with no retries.

## Failure logs

`[Upstash REST] Command failed:` now includes structured fields:

- `operation`: `rate-limit`, `cache-get`, `cache-set`, `key-claim`,
  `telemetry-sample`, `lock-acquire`, `lock-release`, or `key-delete`.
- `failure`: `timeout`, `aborted`, `http`, `redis`, `invalid-response`, or `network`.
- `stage`: `fetch` (before response headers) or `response` (after headers).
- `elapsed_ms`: wall-clock time from the command attempt to the failure.
- `timeout_ms`: the unchanged 2000 ms deadline.
- `http_status`: received HTTP status, or null when no headers arrived.
- `suppressed_since_last_log`: repeated failures suppressed since the previous
  log for the same operation/failure pair in this runtime instance.

Logs are limited to one per operation/failure pair per minute per runtime instance;
distinct operations and failure categories are not hidden by that limit. Logs never
include endpoint URLs, keys, command arguments, values, tokens, or raw provider errors.
The suppression count is not a deployment-wide failure metric.

## Authentication telemetry lifecycle

The middleware passes `NextFetchEvent` to API key authentication. Authentication
registers its telemetry promise with `event.waitUntil()` before returning, so the
runtime can retain that background work after the response without adding the
telemetry duration to authentication response latency. Telemetry failures do not
change authentication results. Direct callers without a lifecycle, or callers whose
registration throws, await telemetry instead of leaving an orphaned promise.

## Interpreting production results

1. Deploy these changes and inspect `operation`, `failure`, and request outcome.
   A `telemetry-sample` failure next to HTTP 200 does not imply that catalog work
   failed. `rate-limit` failures on fail-closed production routes still return 503
   with `RATE_LIMIT_UNAVAILABLE`; security admission policy is unchanged.
2. A `timeout` indicates the client deadline or a runtime timeout exception, not
   proof that Azure Redis is saturated. A timeout at `response` can occur while
   reading the body even if `http_status` is 200. `aborted` is a separate category;
   it does not by itself identify who canceled the operation.
3. Correlate timestamps with bridge latency/errors/restarts and Azure Redis
   latency, CPU/server load, memory and connections. Compare middleware location,
   bridge location and Redis region; the handler region alone does not identify
   the origin of the middleware's Redis calls.
4. Compare against explicit Vercel invocation timeout errors and maximum duration.
   Increasing a route's `maxDuration` does not change the REST adapter's deadline.

These changes improve lifecycle handling and attribution. They do not establish a
production root cause or guarantee that network/provider timeouts disappear.

Offline regressions (no live Redis or database required):

```sh
npm test -- --runInBand --runTestsByPath \
  src/lib/security/__tests__/upstash-rest.test.ts \
  src/middleware/__tests__/apiKeyAuth.test.ts \
  src/middleware/__tests__/auth-telemetry-lifecycle.test.ts \
  src/middleware/__tests__/requestMiddleware.test.ts \
  src/middleware/__tests__/service-expensive-rate-limit.test.ts
```