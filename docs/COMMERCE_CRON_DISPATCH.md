# API-owned commerce scheduling

The API deployment is the single scheduler for commerce background work.
`market-fit/vercel.json` contains no cron entries.

| API cron | Frequency | Internal domain worker |
| --- | --- | --- |
| `/api/cron/marketplace` | Every minute | POST `/api/marketplace/worker` |
| `/api/cron/credit-auto-top-up` | Every five minutes | POST `/api/stripe/auto-top-up/worker` |

The API authenticates Vercel's GET using `CRON_SECRET`, then dispatches exactly one
POST to a fixed path. Business logic remains single-sourced alongside its domain
in market-fit; no provider adapters, Stripe settlement or database mutation logic
are copied into the API. The old app GET endpoints no longer run workers.

## Configuration

API environment:

- `CRON_SECRET`: API Vercel Cron authentication. Never forwarded to the app.
- `NEXT_PUBLIC_APP_URL`: existing application origin, normally
  `https://app.makinari.com`. HTTPS app.makinari.com and Vercel deployment origins
  are supported; explicit localhost is allowed only outside production. Paths,
  URL userinfo, queries and redirects are rejected.
- `SERVICE_API_KEY`: existing server-to-server credential, sent as `x-api-key`.

market-fit environment:

- The existing matching `SERVICE_API_KEY` value. No `CRON_SECRET` is required by these
  workers. Keep existing provider encryption, Supabase and Stripe configuration
  in the domain app.

No additional worker-specific environment variables are required. Reuse the
server-to-server key already configured in both deployments; never expose it
through `NEXT_PUBLIC_*` or commit its value. Do not rotate existing keys for this
change. The app URL is public configuration, not a credential.

## Webhooks are primary, polling is recovery

Rappi and Uber Eats continue to POST signed order/cancellation/courier events
directly to the existing market-fit webhooks. Neither webhook admission nor
manual acceptance depends on the cron credential or dispatcher. Recovery fills
the gaps supported by the providers' APIs and never resends uncertain mutations.
Stripe settlement continues through the existing verified Stripe webhooks.

## Rollout

1. Verify the existing `SERVICE_API_KEY` matches in API and market-fit, and that
   API's `NEXT_PUBLIC_APP_URL` points to the app. Keep API's existing `CRON_SECRET`.
2. Deploy market-fit with no cron entries and POST-only internal workers. This
   retires old GET execution before enabling the new API schedules.
3. Deploy API schedules and verify their authenticated dispatch results. There
   may be a short recovery pause between deployments; marketplace webhooks remain
   available throughout.
4. Check configured hosting plan limits and function duration. No deployment or
   live provider/payment operation is performed by this code change.

The dispatcher rejects unexpected/oversized responses, does not forward caller
headers, and never retries redirects, timeouts, or errors. The remote worker may
have committed effects even when the API could not receive the result; existing
database claims and domain reconciliation remain authoritative.

Offline API verification:

```sh
node node_modules/jest/bin/jest.js --config jest.cron-dispatch.config.js --runInBand
```