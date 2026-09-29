# CORS preflight admission

Browser `OPTIONS` requests are handled in `src/middleware/requestMiddleware.ts`
before route-operation and authentication budgets. They return a response directly;
they never execute the route handler or grant an authenticated principal.

## Budgets

`limitCorsPreflight` in `src/middleware/requestRateLimits.ts` applies two independent
fixed-window limits using the shared Redis admission implementation:

| Scope | Default | Optional environment override |
| --- | --- | --- |
| Client IP | 300/minute | `CORS_PREFLIGHT_REQUESTS_PER_MINUTE` |
| Global | 10,000/minute | `CORS_PREFLIGHT_GLOBAL_REQUESTS_PER_MINUTE` |

Overrides must be positive integers; invalid values use the defaults. Both limits
fail closed with `503` if admission storage is unavailable in production. Exceeded
limits return `429` with `Retry-After`. Preflights remain subject to body-size limits.

Private preflights still require an allowed origin in production. Public visitor
preflights retain their existing dynamic-origin behavior; visitor authorization
remains the responsibility of the actual endpoint. A successful preflight is not
authentication and does not authorize site access.

## Finder behavior

`OPTIONS` no longer consumes the shared expensive-operation budget. Actual Finder
requests still consume the existing 20/minute per-IP and 2,000/minute global
expensive-operation budgets, alongside applicable authentication/principal limits.
No Finder endpoint becomes public and no service API key belongs in the browser.

When diagnosing `429`:

- An `OPTIONS` failure is surfaced by browsers as a CORS/network error; the actual
  request is not sent. Inspect the preflight response in browser network tools.
- An actual request with `error.code: RATE_LIMITED` and `X-RateLimit-*` headers was
  rejected by request admission. Honor `Retry-After`; do not retry in a tight loop.
- A Finder provider error has a different response envelope. Capture the exact
  body and headers before attributing it to this middleware.

Autocomplete must debounce across renders, and the UI must prevent overlapping
Search actions. A single Search intentionally requests both results and totals.

## Regression checks

`src/middleware/__tests__/preflight-rate-limit.test.ts` uses the real admission
wrapper with a simulated counter store. It verifies independent preflight budgets,
continued enforcement of actual operation limits, origin restrictions, production
storage failures, and that successful preflights do not authenticate later calls.