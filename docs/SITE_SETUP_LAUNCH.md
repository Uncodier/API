# Site setup launch and status

`POST /api/site/setup` requires only a valid site UUID and authenticated user
bearer token. The web application exchanges its cookie session for that token
server-side. Middleware verifies session JWTs, then the route independently
verifies the actor and owner/admin site access; caller identity headers, service
API keys, and caller company/contact/URL are not authority.

The existing atomic `initialize_site_billing` RPC must return a validated success
before launch. Missing/failed/timed-out capability is a safe 503 with no direct
financial fallback and no workflow dispatch. Stage-specific deadlines stop
progression after unconfirmed prelaunch work. Omitted locale options do not
overwrite an existing saved locale.

Dispatch uses `WORKFLOW_TASK_QUEUE || 'default'`, matching
`Workflows/src/config/config.ts` and the existing worker. The old fallback
`site-setup-queue` did not match this subscription. `executeWorkflow` calls
Temporal `workflow.start` for asynchronous execution; acceptance is not proof of
worker progress. Previously passed `priority`/`retryAttempts` options were not
used by that method. No broad queue registry is added.

POST now returns accepted/pending, not completed. Unconfirmed starts retain the
server-generated workflow ID so callers can manually check rather than replay.
`GET /api/site/setup?workflow_id=...` independently authenticates and authorizes
the site embedded in the ID. The existing closed-result reader describes first,
then reads completed results; a running workflow cannot hold the HTTP request
open waiting for completion. Feedback exposes allowlisted status/stages/causes
only. Raw contact data, provider failures, and workflow output are not returned.

Explicit worker `status: completed` with success is complete; partial/skipped
work is partial, failed work is failed, and older unknown completed payloads are
unconfirmed. There is no automatic relaunch, cancellation, or retry for ambiguous
executions. Worker-side trusted site enrichment and stage handling are maintained
in the Workflows repository.

## Offline verification

```sh
node node_modules/jest/bin/jest.js --config jest.billing.config.js --runInBand src/app/api/site/setup/__tests__
npm test -- --runInBand src/middleware/__tests__/site-setup-session.test.ts
npx tsc --noEmit --incremental false
```

The suites use mocked authentication/database/Temporal calls, generated synthetic
tokens, and no remote writes. The source queue mismatch occurs after billing
initialization and therefore cannot alone explain an initializer not being
called. The earlier web create-site API-key environment guard could skip the
request before reaching this API at all. A specific historical remote execution
cause requires separately authorized logs; source diagnosis is not such evidence.