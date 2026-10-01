# Verified internal-service admission

`requestMiddleware` gives a separate expensive-operation budget **only** to a
credential verified against `SERVICE_API_KEY` on a private expensive route
(Finder, agents, robots, private AI/workflow operations, etc.). No endpoint is
made public and no caller-supplied identity header grants this budget.

## Authentication and ordering

1. Existing body-size checks and `OPTIONS` handling run first. A preflight never
   authenticates a later operation or spends a service/expensive budget.
2. Private expensive requests require an allowed CORS origin in production when
   an Origin is supplied. This validation precedes credential verification and
   admission storage; an origin-less worker still requires authentication.
3. The shared `src/lib/security/api-key-credential.ts` helper extracts the first
   nonempty `x-api-key`, otherwise `Authorization: Bearer <key>` or raw
   `Authorization`. It preserves the existing case-sensitive `Bearer ` parsing
   and does not trim the extracted value. Only the configured service key is
   trimmed. WebCrypto HMAC verification compares the complete credential without
   a JavaScript secret-dependent prefix/length comparison. Empty configuration
   does not enable service admission.
4. A verified candidate **still calls `apiKeyAuth`**. It re-verifies the same
   extracted credential, applies `service-api-key`, strips caller-supplied
   `x-api-key-data`, `x-auth-user-id`, `x-auth-validated`, `x-required-scope`, and
   forwards newly authenticated service metadata upstream via
   `NextResponse.next({ request: { headers } })` (not client response headers).
5. Successful authentication then applies `service-expensive`, followed by the
   **same** `expensive-global` bucket used by ordinary expensive traffic.

This path does not consume `expensive` per-IP, `api`/public per-IP, or
`api-key-validation` per-IP/global budgets. Verification is local and does not
call the API-key database. Invalid/missing credentials and spoofed `isService`
metadata retain ordinary admission and authentication. Database keys and browser
user sessions do not qualify for the internal service budget.

## Limits and environment variables

| Budget | Default per 60-second fixed window | Environment override |
| --- | ---: | --- |
| `service-expensive`, identity `service-key` | **600** | `SERVICE_EXPENSIVE_REQUESTS_PER_MINUTE` |
| `service-api-key`, identity `service-key` | **5,000** | `SERVICE_API_KEY_REQUESTS_PER_MINUTE` |
| `expensive-global`, identity `global` | **2,000** | `EXPENSIVE_API_GLOBAL_REQUESTS_PER_MINUTE` |

Overrides must parse as positive safe integers; missing, empty, zero, negative,
fractional, nonnumeric, infinite or unsafe values use the default. No environment
or deployed configuration is changed by this implementation.

The credential sent by Workflows/workers (their `API_KEY`, where configured)
must match the API's `SERVICE_API_KEY`; a regular database API key does not
qualify. Both the API admission change and the Workflows retry change must be
released through the normal deployment process before relying on this behavior.
No deployment, restart, or secret/configuration update is part of these changes.

The effective default service allowance for these expensive routes is **at most
600/minute**, not 5,000: every admitted request must satisfy all three limits.
All workers, IPs, routes and methods share the service identity. Other service
requests consume the existing 5,000/minute authentication budget when passing
through `apiKeyAuth`; ordinary expensive traffic also consumes the shared
2,000/minute global budget. Earlier buckets are not refunded when a later bucket
rejects admission. There is no reserved capacity or provider quota implied by
600/minute, and individual handlers may impose additional limits.

## Boundaries retained

- Public endpoints, including public generation and visitor/customer-support
  methods under `/api/agents/` and `/api/workflow/`, keep their existing budgets
  and handler authorization. Supplying the service key does not move them onto
  `service-expensive`.
- Webhooks keep their webhook limits and independent signature verification,
  including the webhook paths under `/api/agents/`.
- `/api/visitors/identity/token`, `/api/visitors/identity/token/current-user`, and
  `/api/visitors/session/:id/identify/token` keep their admission policies and
  independent identity proofs. The middleware does not grant a service principal
  to these handlers.
- Non-expensive private routes keep their existing admission flow.

## Rejections and retries

- Exceeding any budget returns `429`, `error.code: RATE_LIMITED`, `Retry-After`,
  and `X-RateLimit-*`. The route handler has not executed. Honor `Retry-After`
  with bounded retries; do not retry in a tight loop.
- Admission storage failure/unconfigured storage fails closed in production
  with `503`, `error.code: RATE_LIMIT_UNAVAILABLE`, and `Retry-After: 30`.
  Existing development/test fail-open behavior is unchanged.
- A provider's `429` is **not** this admission envelope. Do not automatically
  retry a potentially billable operation just because its status is `429`.
- Credentials never appear in response bodies, client-facing rate-limit/CORS
  headers, counter keys or service telemetry. Raw authentication headers retain
  their existing upstream-only forwarding behavior; keep service keys out of
  browsers and logs.

## Offline regression checks

```sh
PATH=/opt/homebrew/bin:$PATH npm test -- --runInBand \
  src/middleware/__tests__ src/lib/security/__tests__/api-key-credential.test.ts
```

`service-expensive-rate-limit.test.ts` runs real middleware, `apiKeyAuth`,
credential verification, admission and Upstash REST code against a simulated
REST counter store; database validation and telemetry are mocked. It covers 600
successful requests from one IP and rejection 601, exhausted ordinary budgets,
shared global accounting, service authentication limits, overrides/fallbacks,
503 failures, spoofing/precedence, CORS/body/preflight and excluded routes.
No production services, Next environment loader or harness-config changes are
required.