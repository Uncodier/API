# Trusted inference HTTP routing

Local implementation checkpoint; no production activation or paid probe performed.

`customer-routing-http.ts` propagates host-owned execution references through the
`x-host-inference-routing` header. A five-minute HMAC ticket binds the reference,
destination pathname, operation namespace, expiration and optional host summary
capability. Signing uses only `SERVICE_API_KEY`; missing configuration fails closed.
Tickets contain no provider credentials. Never construct a reference from request
JSON or sign a caller-provided payer/model flag.

Each receiving inference route validates real service/API-key/session credentials
through `resolveToolRequestPrincipal`, authorizes the requested site through
`canToolPrincipalAccessSite`, then enters `withHttpExecutionRouting`. Metadata
headers, body identities and middleware are not authentication. Only authenticated
internal legacy calls may omit a site, and a signed ticket without a site is denied.

Signed platform/customer selections are not reselected at the destination. A
customer reference is revalidated before execution; a revoked reference does not
fall back to a platform account. New unsigned site admissions respect the rollout
gate and avoid connection-schema reads when disabled. Host operation counters
provide stable nested namespaces for the durable receipt layer; the ticket itself
is not a replacement for durable dispatch deduplication.

Covered receivers include text, embeddings, summary, JSON continuation, and the
instance tool's auto-rename boundary. Generic server callers, summary generation,
conversation and continuation clients forward the host reference and site with
service authentication. Server generic fetches use the configured API origin;
browser fetches remain relative and do not gain service credentials. Redirects
are rejected to avoid forwarding signed headers to a redirected host.

Focused offline regression coverage:

- `src/lib/services/ai/__tests__/customer-routing-http.test.ts`
- `src/lib/services/ai/__tests__/customer-http-callers.test.ts`
- `src/app/api/ai/__tests__/customer-http.test.ts`

These tests cover real customer adapter selection with mocked provider transport,
authentication and cross-site denial, tampering/path/expiry rejection, signed
operation propagation, revocation, and rollout-disabled global compatibility.
They do not establish live provider support or deployment readiness.