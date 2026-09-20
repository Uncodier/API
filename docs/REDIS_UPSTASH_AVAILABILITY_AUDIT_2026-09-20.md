# Redis/Upstash Availability and Consistency Audit

Captured: 2026-09-20

Status: point-in-time engineering audit. Current code, migrations, and tests
remain authoritative.

## Repository boundary

This document covers only the `API` repository. It evaluates the Redis and
Upstash controls already implemented by the API server. It does not contain the
route and client-amplification findings from the separate `market-fit` web
application.

## Executive summary

The API server already has a substantial Redis control plane:

- edge-compatible Upstash REST commands;
- atomic request rate limits;
- per-IP, per-principal, and global budgets;
- short-lived authentication and public-data caches;
- owner-token distributed locks;
- Redis Streams queues with backlog admission;
- session-recording sampling, concurrency, request, and byte budgets;
- database claims and idempotent sinks for selected durable workflows.

The main risks are therefore consistency and failure semantics rather than
missing infrastructure. The highest-priority issues are:

1. Redis outages can be interpreted differently by each primitive and can cause
   legitimate webhook events to be acknowledged as duplicates.
2. Several business webhooks, including Stripe, rely on Redis-only
   deduplication rather than durable database claims.
3. Durable queues and expendable caches are configured to share one
   no-eviction Redis database.
4. Some locks lack ownership tokens, conditional release, lease renewal, or
   fencing.
5. Several cache and rate-limit keys expose raw email addresses or omit
   tenant/output dimensions.

## Current implementation

### Clients and configuration

[`src/lib/security/upstash-rest.ts`](../src/lib/security/upstash-rest.ts)
provides REST-based operations suitable for middleware:

- `sha256`;
- `checkRateLimit`;
- `getCachedJson` and `setCachedJson`;
- `claimKey`;
- `acquireLock` and token-checked `releaseLock`;
- `deleteKey`.

It uses a two-second timeout and can derive REST credentials from an Upstash
`REDIS_URL`.

[`src/lib/utils/redis-client.ts`](../src/lib/utils/redis-client.ts) provides the
singleton `ioredis` client used by streams and richer data structures.
[`src/lib/utils/tracking-redis-client.ts`](../src/lib/utils/tracking-redis-client.ts)
requires explicit Redis configuration for durable tracking.

The expected variables are documented in
[`src/config/env.example`](../src/config/env.example):

- `REDIS_URL`;
- `UPSTASH_REDIS_REST_URL`;
- `UPSTASH_REDIS_REST_TOKEN`;
- queue limits;
- API, provider, and visitor rate-limit overrides.

### Request admission

[`src/middleware/requestMiddleware.ts`](../src/middleware/requestMiddleware.ts)
classifies API traffic and invokes
[`src/lib/security/request-rate-limit.ts`](../src/lib/security/request-rate-limit.ts).
The limiter uses an atomic Lua `INCR` plus expiry operation.

Current default per-IP policy:

| Route class | Default |
| --- | --- |
| Status | 60/minute |
| Webhooks | 120/minute |
| Expensive AI, agent, and workflow routes | 20/minute |
| Public reads | 60/minute |
| Tracking and visitor routes | 300/minute |
| Cron | 120/minute |
| Other API routes | 300/minute |

Additional global budgets include:

| Route class | Default |
| --- | --- |
| Public generation | 200/hour |
| Webhooks | 10,000/minute |
| Expensive API routes | 2,000/minute |
| Public reads/status | 1,000/minute |
| Tracking | 50,000/minute |
| Visitor session creation | 500/minute |

Authenticated bearer users receive a separate 600/minute budget. API-key and
bearer validation also have per-client and global admission limits.

Rate-limit denials return `429` with `Retry-After` and `X-RateLimit-*` headers.
Policies marked `failClosed` return `503` in production when admission is
unavailable.

### Caches

The REST cache is used for:

- bearer validation: 60 seconds positive, 10 seconds negative;
- API-key validation: 60 seconds positive, 10 seconds negative;
- site access: 60 seconds allowed, 10 seconds denied;
- site-origin validation: 300 seconds allowed, 30 seconds denied;
- public-site resolution: 300 seconds found, 30 seconds absent;
- published content: 30 seconds;
- public tracking configuration: 60 seconds;
- public status: 30 seconds;
- Zavu sender settings: 300 seconds positive, 30 seconds negative.

The main implementations are
[`requestMiddleware.ts`](../src/middleware/requestMiddleware.ts),
[`ApiKeyService.ts`](../src/lib/services/api-keys/ApiKeyService.ts),
[`site-access.ts`](../src/lib/security/site-access.ts), and
[`public-site-context.ts`](../src/lib/security/public-site-context.ts). Direct
`ioredis` caches also exist for site analysis and personalization. Process-local
caches cannot coordinate serverless instances.

### Distributed locks

The strongest Redis lock primitive uses:

1. a random UUID owner token;
2. `SET key token EX ttl NX`;
3. compare-and-delete Lua release.

It protects image and video generation and is appropriate for duplicate-load
suppression:

- [`src/app/api/ai/image/route.ts`](../src/app/api/ai/image/route.ts);
- [`src/app/api/ai/video/route.ts`](../src/app/api/ai/video/route.ts).

Redis Stream workers use the same owner-token release pattern:

- [`src/lib/services/tracking-event-queue.ts`](../src/lib/services/tracking-event-queue.ts);
- [`src/lib/services/session-recording-queue.ts`](../src/lib/services/session-recording-queue.ts).

For correctness-sensitive long-running work, the stronger pattern is the
database claim with owner token, renewal, stale recovery, and token-fenced
completion in
[`src/lib/services/workflow-robot/execution-claim.ts`](../src/lib/services/workflow-robot/execution-claim.ts).

### Queues and admission

The tracking queue provides:

- atomic enqueue below a backlog cap;
- Redis consumer groups;
- pending-message reclaim;
- bounded batches;
- atomic acknowledgement and deletion;
- dead-letter handling;
- an independently idempotent database sink.

The session-recording admission script in
[`src/lib/services/session-recording-admission.ts`](../src/lib/services/session-recording-admission.ts)
atomically evaluates:

- deterministic sampling;
- active sessions globally and per site;
- global and per-site bytes per minute;
- requests per session per minute;
- current queue backlog.

These are strong examples of Redis being used for availability and
backpressure, while Postgres preserves durable correctness.

## Findings

### API-01 — Failure semantics are inconsistent across primitives

Severity: critical

[`src/lib/security/upstash-rest.ts`](../src/lib/security/upstash-rest.ts)
distinguishes unconfigured Redis from configured-but-unavailable Redis, but each
operation interprets those states differently:

- `checkRateLimit` initially returns an allowed decision when Redis is
  unavailable; the route policy may later convert it to `503`;
- cache reads become misses;
- `setCachedJson` reports success when Redis is unconfigured but failure during
  a configured outage;
- `claimKey` allows processing when unconfigured but denies the claim during a
  configured outage;
- `acquireLock` returns a synthetic token when unconfigured but no token during
  a configured outage.

Webhook callers commonly interpret `claimKey === false` as "duplicate." A
configured Redis outage can therefore make a legitimate provider event look
already processed and cause it to be acknowledged without business effects.

Required change:

- return an explicit discriminated state such as `acquired`, `contended`,
  `unavailable`, or `unconfigured`;
- require each caller to define unavailable behavior;
- never collapse unavailable into duplicate;
- record metrics separately for contention and infrastructure failure.

### API-02 — Business webhook deduplication is Redis-only

Severity: critical

Redis claims are used by WhatsApp, Twilio Gear, Zavu, Outstand, Vercel, agent
WhatsApp, and Stripe webhook paths.

The Stripe route in
[`src/app/api/integrations/stripe/webhook/route.ts`](../src/app/api/integrations/stripe/webhook/route.ts)
uses a five-minute Redis processing lock and a three-day processed value. A
flush, eviction, outage, TTL expiry, or processing time beyond the lock lease
can permit duplicate business effects.

Required change:

- use a durable database claim keyed by provider event ID;
- store claim owner, attempt count, status, and stale-claim expiry;
- token-fence completion and failure;
- protect individual business effects with unique transaction identities;
- retain Redis only as an optional load-shedding layer.

Telemetry sampling and non-business duplicate suppression can remain
best-effort Redis claims.

### API-03 — Fixed-window limiting permits boundary bursts

Severity: high

The Lua limiter is atomic, but it is a fixed window. A client can consume one
window at its end and the next window immediately afterward, producing a burst
near twice the nominal limit.

Required change:

- use sliding-window, GCRA, or token-bucket admission for expensive and
  provider-limited routes;
- keep fixed windows for coarse global emergency budgets where simplicity is
  preferred;
- add tests around window boundaries and clock behavior.

### API-04 — Durable queues and caches share one capacity policy

Severity: critical

[`src/config/env.example`](../src/config/env.example) recommends one shared
Upstash database with eviction disabled for caches, locks, tracking, and
recording.

No eviction protects streams, but unbounded or high-cardinality cache growth can
consume capacity and prevent durable queue writes. Allowing eviction would
create the inverse failure by discarding pending work.

Required change:

- use a dedicated no-eviction Redis database for durable streams;
- use a separate capacity-limited database for caches, limits, claims, and
  locks;
- apply maximum lengths and retention to dead-letter streams;
- alert on memory, queue depth, write rejection, and key growth.

### API-05 — Some keys contain raw personal identifiers

Severity: high

System notification and email-send limits include raw email addresses in Redis
keys. Redis keys are visible in operational tooling, logs, backups, and usage
analysis.

Relevant paths:

- [`src/app/api/agents/tools/system_notification/route.ts`](../src/app/api/agents/tools/system_notification/route.ts);
- [`src/lib/services/email/email-send-rate-limit.ts`](../src/lib/services/email/email-send-rate-limit.ts).

Required change:

- normalize the email;
- derive a keyed HMAC or SHA-256 identity;
- version the namespace;
- never log the unhashed identity or complete Redis key.

### API-06 — Some locks do not enforce ownership

Severity: critical

The plan lock in
[`src/app/api/robots/instance/assistant/plan-steps.ts`](../src/app/api/robots/instance/assistant/plan-steps.ts)
uses a constant lock value and unconditional `DEL`. An expired older worker can
delete a newer worker's lock.

The email-send permit is acquired atomically, but release is also an
unconditional delete.

Required change:

- require a random owner token for every releasable lock;
- release using compare-and-delete Lua;
- renew leases for work that may exceed the initial TTL;
- use a database lease or fencing token where overlapping effects would violate
  correctness.

### API-07 — Long-running locks have no renewal or fencing

Severity: high

AI generation locks and queue worker locks use safe owner-token release but do
not renew their leases. Work that outlives the TTL can overlap with a successor.

Required change:

- add owner-checked renewal for long or variable operations;
- stop side effects after ownership is lost;
- add a fencing token or durable database claim when stale work can still
  mutate state;
- keep simple Redis locks only for load suppression.

### API-08 — Some cache writes are non-atomic or incompletely scoped

Severity: high

The personalization cache performs `SET` and `EXPIRE` separately and writes
related keys without a transaction. Partial failure can leave incomplete or
non-expiring state.

Prompt-based image, video, and summary caches omit some output-affecting
dimensions such as tenant, provider/model, quality, or references. Public prompt
routes can also return cached content before authorization.

The site-analysis cache derives keys from a base64-like URL representation
rather than canonical input plus a bounded hash.

Required change:

- use atomic `SET EX` or a transaction/Lua script;
- include tenant and every output-varying dimension;
- authorize before serving tenant-sensitive cached content;
- canonicalize then hash long or attacker-controlled key material;
- use shorter negative TTLs and explicit schema versions.

### API-09 — Process-local caches cannot coordinate serverless instances

Severity: medium

The command and agent caches are in-memory and per-process:

- [`src/lib/agentbase/services/command/CommandCache.ts`](../src/lib/agentbase/services/command/CommandCache.ts);
- [`src/lib/agentbase/services/agent/AgentCacheService.ts`](../src/lib/agentbase/services/agent/AgentCacheService.ts).

This is acceptable for opportunistic acceleration, but not for authorization,
idempotency, concurrency, or quota enforcement. Documentation and call sites
should preserve that distinction.

### API-10 — Recording configuration is not fully documented

Severity: medium

The recording admission implementation reads several
`SESSION_RECORDING_*` settings that are absent from
[`src/config/env.example`](../src/config/env.example), including sampling,
active-session, byte, request, and queue limits.

Required change:

- document every setting and unit;
- validate bounds at startup;
- expose effective non-secret values in internal diagnostics;
- test defaults and invalid overrides.

### API-11 — Test coverage misses critical failure paths

Severity: high

Existing tests cover rate-limit denial, cache round trips, email permits,
tracking and recording queues, admission, API-key caches, database workflow
claims, and idempotent sinks.

Important gaps include:

- `claimKey` unavailable versus contended behavior;
- lock acquisition, owner-checked release, renewal, and expiry;
- response headers on successful and denied rate limits;
- Redis-backed webhook duplicate, outage, and concurrent delivery;
- fixed-window boundary bursts;
- prompt-cache tenant and model isolation;
- queue/database separation failure;
- middleware behavior when trusted proxy headers are absent.

## Recommended operating model

### Classify Redis data by durability

| Class | Examples | Failure behavior |
| --- | --- | --- |
| Expendable | caches, rate counters, telemetry sampling | miss or controlled fail-open |
| Availability-critical | provider budgets, admission, semaphores | explicit 503 or load shedding |
| Coordination | single-flight and worker locks | owner-aware unavailable response |
| Durable work | tracking/recording streams | fail closed; never silently drop |
| Business correctness | payments and provider event effects | Postgres/provider source of truth |

Do not allow one boolean return value to represent both lock contention and
Redis unavailability.

### Standardize key construction

Use:

`<purpose>:v<schema>:<scope>:<hashed-identity>:<time-bucket>`

Requirements:

- tenant scope for tenant-specific data;
- keyed hashes for personal or secret identifiers;
- canonical input ordering;
- bounded key length;
- explicit TTL for every expendable key;
- Redis Cluster hash tags only where atomic multi-key operations require them.

### Standardize failure policy

- Public expensive generation and ingestion: fail closed with `503`.
- Durable queues: fail closed and provide retry guidance.
- Auth caches: fall back to authoritative validation when safe.
- Ordinary response caches: treat failure as a miss.
- Telemetry sampling: fail open or drop intentionally.
- Webhook business events: persist durably or return a retryable non-2xx; never
  acknowledge an event merely because Redis is unavailable.

### Observability

Track:

- allowed, denied, unavailable, and unconfigured decisions;
- cache hit, miss, stale, and regeneration contention;
- lock acquisition, renewal, expiry, and owner mismatch;
- queue depth, pending age, reclaim count, dead letters, and rejected enqueue;
- Redis latency, timeout, memory, command errors, and capacity rejection;
- provider quota consumption by route class.

## Implementation sequence

### Phase 0 — Correct failure and ownership semantics

1. Replace boolean claims with explicit result states.
2. Convert unsafe releases to owner-token compare-and-delete.
3. Hash email and other personal identifiers in keys.
4. Add missing configuration documentation and validation.

### Phase 1 — Make business idempotency durable

1. Add provider-event database claims, starting with Stripe.
2. Token-fence completion and failure.
3. Add independently idempotent business-effect records.
4. Keep Redis only for early duplicate suppression and load shedding.

### Phase 2 — Isolate capacity and improve admission

1. Separate durable streams from cache/rate-limit storage.
2. Add stream retention and dead-letter caps.
3. Introduce sliding or token-bucket limits for burst-sensitive routes.
4. Validate the trusted proxy boundary for IP-derived limits.

### Phase 3 — Harden caches and leases

1. Canonicalize and tenant-scope cache keys.
2. Make multi-key writes atomic.
3. Add lock renewal and fencing where operations can exceed the lease.
4. Replace correctness-sensitive process-local caches or document them as
   best-effort only.

## Test requirements

Use Jest and cover:

- unconfigured, unavailable, contended, acquired, and released states;
- production fail-open and fail-closed policy behavior;
- fixed-window boundaries and replacement algorithms;
- owner mismatch, lease expiry, renewal, and stale-worker fencing;
- concurrent webhook delivery, Redis outage, durable retry, and replay;
- queue-full, Redis restart, reclaim, poison message, and dead-letter behavior;
- cache tenant isolation and complete output dimensions;
- configuration defaults, invalid values, and effective runtime settings.

Production builds, remote migrations, and destructive Redis tests are not
required for this audit. Validate changes with focused Jest suites and lint
checks as each phase is implemented.
