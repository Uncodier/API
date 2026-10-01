# Durable IcyPeas single-email resolver

## Rollout order (operator action; not performed by this change)

1. Review/apply `supabase/migrations/20261002000000_icypeas_email_searches.sql` to the intended environment through the normal migration process **before** deploying the API. Do not deploy unrelated pending migrations as part of this repair.
2. Configure server-only `ICYPEAS_API_KEY` (raw Authorization value), Supabase service-role credentials and the shared Upstash REST configuration already used by `src/lib/security/upstash-rest.ts`. Missing/unavailable storage fails closed even outside production.
3. Deploy the API resolver; then deploy the separately patched worker that provides authenticated site context and polls this endpoint. Old workers must not fall back to the legacy paid `/email-search` endpoint for this operation.
4. Start with an explicitly approved, bounded **single repair**. No bulk runner, automatic backfill or cancellation/reset is introduced here. ICP targets must have an explicit credit budget, serial execution and durable checkpoints. Bulk adoption requires a separate design and approval; official IcyPeas documentation recommends its bulk API for volume, not fan-out against this single-search endpoint.

No production requests, migrations or deployments are needed to run the tests below.

## Endpoint and authentication

`POST /api/integrations/icypeas/email-search/resolve`

```json
{
  "site_id": "00000000-0000-4000-8000-000000000001",
  "firstname": "Ada",
  "lastname": "Lovelace",
  "domainOrCompany": "example.com"
}
```

`site_id` must be a UUID and at least one name must be nonblank. Both names are optional individually, not together. Maximum lengths: names 200, domain/company 500. Unknown fields (including client-chosen `searchId`, `custom` or job IDs) are rejected. No domain/company-only or cross-person fallback.

The private middleware validates API credentials or a Supabase user token and **strips client-supplied principal headers**. The route requires `hasAuthenticatedPrincipal`, then `isInternalServiceRequest` or `canAccessSite`. Service keys are trusted across sites; other authenticated keys/users must be authorized for that site. Plain site/user IDs do not authenticate. The site FK also rejects nonexistent sites for internal requests. Every job lookup/update is constrained by `site_id`; no public read-by-search-ID endpoint exists. Do not exempt this route from middleware or forward untrusted `x-api-key-data`/`x-auth-*` headers from another ingress.

Every successful HTTP response has precisely the standard outer envelope:

```json
{
  "success": true,
  "data": {
    "outcome": "pending",
    "searchId": "provider-search-id",
    "status": "NONE",
    "retryAfterMs": 10000
  }
}
```

`outcome` is `pending | matched | no_match | failed`. `status` is always present. `searchId` is present only after its acknowledgement is durably stored. `matched` contains `email` (the first result) and `emails: [{email, certainty?}]`. Other optional fields are `retryAfterMs` and a safe, visible `error`. No nested provider `success` object, raw provider body, or invented `verified` flag is returned. Authorization/input/configuration/storage failures return non-2xx `{success:false,error:{code,message}}`. Responses use `Cache-Control: no-store`; caching is the durable DB row, not a shared HTTP cache.

## One step per request; at most one submit per canonical job

- Normalize names/company with NFC, trim, collapse whitespace, lowercase; reject controls. Store exactly this canonical input and hash `JSON.stringify(['v1', firstname, lastname, domainOrCompany])` with SHA-256. No accent/punctuation stripping, field merging, domain/URL guessing or person lookup reuse. Do not change this normalization/version casually: a new hash can cause a new paid job.
- Read or insert a durable `ready` row unique on `(site_id,input_hash)`. The site FK is checked before spending. A concurrent insert loser reads the winner; no upsert overwrites state.
- Obtain global submit admission, **then** atomically claim `ready -> submitting`. Only the CAS winner can call `POST https://app.icypeas.com/api/email-search` with canonical names/company and `custom: {externalId: job.id}`. `externalId` is correlation only: IcyPeas explicitly does **not** check uniqueness.
- Require provider `success === true` and valid `item._id`. Persist the ID as `pending` before returning. Never poll in the submit request.
- Subsequent requests read only `POST /bulk-single-searchs/read` with `{id: storedSearchId}`. Poll due/`next_poll_at` is CAS-claimed at least 10 seconds apart; a unique poll token fences delayed responses. Conditional `state = pending` writes plus the SQL terminal guard prevent terminal regression.
- Cache `matched`, `no_match`, and `failed` indefinitely. A fresh worker execution with the same site/canonical input resumes the same row without a new search or charge. There is no automatic TTL, delete, reset, cancel or replacement submit.

All provider fetches use `AbortSignal.timeout(10000)`, no redirects and no implicit retries. Each request performs zero or one provider call. Response items must have the exact stored ID; only the official `items[]` single-result envelope is accepted. Results are limited to 20 syntax-checked emails; certainty is passed through as a bounded string, not interpreted as verification. Oversized or malformed responses never mean `no_match`.

| Provider status | API outcome |
| --- | --- |
| `NONE`, `SCHEDULED`, `IN_PROGRESS` | `pending` |
| `FOUND`, `DEBITED` | `matched` only with valid `results.emails[]` |
| `NOT_FOUND`, `DEBITED_NOT_FOUND` | `no_match` only with empty `results.emails[]` |
| `BAD_INPUT`, `INSUFFICIENT_FUNDS`, `ABORTED` | `failed` |
| Unknown status, wrong/missing ID, malformed result | visible `failed`, never no-match |

Read network/invalid-JSON/5xx errors stay pending with the same ID; read 429s persist their cooldown. Retry-After supports seconds/HTTP dates and is never shortened; unrepresentable numeric cooldowns fail closed. Explicit submit rejection (including credit/auth/429) is cached `failed`, **not** retried automatically.

## Shared admission and consumer behavior

Global upstream limits use the existing `checkRateLimit`, not process-local counters or per-site buckets:

| Redis key | Applied conservative budget | Official provider ceiling |
| --- | --- | --- |
| `icypeas:email-search` | 5 / second | 10 / second |
| `icypeas:result-read` | 15 / minute | 30 / minute |

The half-capacity margin accounts for adjacent fixed-window bursts in the shared helper. All resolver instances must use the same Redis. Unknown/unconfigured/unavailable limiter storage prevents provider calls and returns `pending` + `retryAfterMs` + visible error. A blocked submit stays `ready`; a blocked poll persists its next due time. Legacy integrations are unchanged and do **not** participate in these new buckets: avoid concurrently using the same upstream key from legacy/other systems, or coordinate those consumers separately. These limits are in addition to API middleware request admission.

The worker should authenticate normally, send the same `site_id` and canonical identity on every call, keep the returned search ID/checkpoint, and wait at least `retryAfterMs` between calls (15 seconds by default is suitable). Its bounded poll deadline belongs to the worker, not this durable row. A deadline/cancellation must **not** delete/reset the job, start another paid search or treat pending as no-match. A new execution resumes with the same input. Transient non-2xx storage/admission failures can safely retry this resolver, never the legacy submit route. `failed` is not `no_match` and must remain visible; credit/auth/ambiguous errors require operator attention rather than a replacement charge. Worker-specific email validation remains required, including certainty policy.

## Ambiguous submit / manual recovery

This is deliberately **not** an exactly-once guarantee for the external provider. A crash can happen after the durable claim but before sending, after the provider accepts, or before the acknowledgement is stored. We prefer a stranded job over duplicate spending.

- A recent `submitting` row returns `pending/SUBMITTING` for 30 seconds while the sole request is in flight. This age check is **not** a lease/reclaim mechanism. Once stale it returns `failed/SUBMISSION_UNKNOWN` with the job ID; it never automatically transitions back to ready.
- Network/timeout, HTTP 5xx/408, invalid JSON/missing provider ID, or failed ID persistence marks `unknown` best-effort. If even that write fails, the original durable `submitting` row still blocks another submit. The request returns a visible manual-recovery error. If ID persistence actually committed despite a lost ACK, a subsequent call discovers the existing ID and only polls it.
- Operators must inspect the exact site/job/canonical input and provider account history (including the correlation `externalId`) without creating a new search. Do not assume external IDs are idempotent or unique upstream. If the exact existing provider ID can be independently established, use a reviewed service-role conditional update scoped by site + job ID + `state IN ('submitting','unknown')` + `search_id IS NULL` to attach that ID, set `pending`, clear the error, and permit a read. Do not disable the trigger, change identity, reset to ready or delete a row. If acceptance cannot be established safely, leave it blocked and escalate; there is no automatic recovery endpoint.
- Terminal rows/search IDs/identity are immutable. A SQL guard rejects resets and terminal overwrites. RLS is enabled, no client policies exist, and PUBLIC/anon/authenticated have no table privileges. Service role receives only SELECT/INSERT/UPDATE after all inherited default table grants are revoked. The restrictive site FK intentionally prevents accidental cascade deletion of the deduplication ledger.

## Offline tests

Uses existing Jest/ts-jest and PGlite dependencies; no configuration or package changes:

```sh
PATH=/opt/homebrew/bin:$PATH npm test -- --runInBand --runTestsByPath \
  src/app/api/integrations/icypeas/email-search/resolve/__tests__/route.test.ts \
  src/app/api/integrations/icypeas/email-search/resolve/__tests__/migration.test.ts
```

The route/resolver and auth helpers are real; DB and external fetches are fake. Tests cover duplicate insert/submit races, poll fencing, stored terminal replay, auth boundaries, malformed/mismatched provider data, credits/429, unavailable Redis/DB, lost ACK before/after commit, and no automatic unknown resubmission. PGlite executes the migration with permissive default ACLs to verify effective privileges, RLS, uniqueness, FK, atomic claims and immutability. No credentials, `.env`, live providers or production databases are loaded.

## Official schema references (reviewed 2026-10-01)

- [Single email discovery](https://api-doc.icypeas.com/find-emails/email-discovery): `custom.externalId`, explicitly not unique/idempotent.
- [Retrieve results](https://api-doc.icypeas.com/fetch-results/search-item): `POST /bulk-single-searchs/read`.
- Hidden response schema/example in [official JS aecc3cad.6fce926e.js](https://api-doc.icypeas.com/assets/js/aecc3cad.6fce926e.js): `{success:true,items:[{_id,status,results:{emails:[{email,certainty,...}]}}]}`.
- [Search statuses](https://api-doc.icypeas.com/how-works/search_statuses).
- [Certainties](https://api-doc.icypeas.com/how-works/certainties): `ultra_sure`/`very_sure`, `probable`, `not_found`, `undeliverable`; not a universal verified boolean.
- [Rate limits](https://api-doc.icypeas.com/how-works/rate_limits).