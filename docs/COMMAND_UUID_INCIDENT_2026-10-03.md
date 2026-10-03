# Command UUID errors — 2026-10-03

## Evidence (read-only production investigation)

Project: `rnjgeloamtszdjplmqxy` (Makinari). Window:
`2026-10-03T01:00:00Z`–`2026-10-03T02:00:00Z`.

- The reported `cmd_1790992220939_ox8hy6z` produced **551** Postgres
  `22P02` errors between `01:50:28.997Z` and `01:55:19.816Z`.
- Edge logs identify a Node client requesting
  `/rest/v1/commands?select=*&id=eq.cmd_1790992220939_ox8hy6z`.
  Postgres logs confirm `SELECT public.commands.* WHERE id = $1`.
- The timestamp embedded in the local ID is `01:50:20.939Z`. The only command
  created in the surrounding ten-second window was created at
  `01:50:20.878902Z`, with task `generate contact email addresses for lead`.
  It was already `completed` when inspected. This task and the polling pattern
  identify the lead-contact generation path; no application request trace was
  available to directly join the local alias to its database row.
- Three other local command IDs produced 545, 544 and 534 UUID errors in the
  same hour. These counts do not establish the cause of every error in the
  larger dashboard histogram.

## Cause

`CommandSubmitService` persisted a UUID but returned and emitted a new
process-local `cmd_<timestamp>_<random>` alias. Four Data Analyst routes tried
to rediscover the UUID by selecting the latest command with matching agent and
description. If that lookup failed, they sent the alias directly to `commands.id`.
They ignored PostgREST errors and tried again every 500 ms, up to 580 attempts.
Matching by description could also select the wrong concurrent command.

Affected API routes:

- `/api/agents/dataAnalyst/leadContactGeneration`
- `/api/agents/dataAnalyst/companyContactGeneration`
- `/api/agents/dataAnalyst/leadSegmentation`
- `/api/agents/dataAnalyst/analysis`

## Repair

- Persisted submissions now return, store and emit the same database UUID.
  Existing execution metadata and background fields remain available.
- Existing legacy aliases can still resolve through the in-process store,
  cache mapping or `metadata.dbUuid`. Unresolved aliases never reach Postgres.
  Memory-only fallback commands remain local; they cannot be recovered by a
  different worker after process loss.
- All four routes poll the exact submitted command through fresh service reads,
  not a description search. Polls are sequential, normally 2 seconds apart,
  with a 290-second elapsed-time budget. Completed, failed and cancelled commands
  stop polling; an unresolved command fails immediately. An already in-flight
  database request is not cancelled by this budget, and route setup time still
  counts toward Vercel's 300-second limit.
- The low-level command getter rejects non-UUIDs before its circuit breaker or
  PostgREST. It retains SQLSTATE and does not retry `22P02`; transient failures
  retain the existing backoff.

## Validation and rollout

Run `npm run test:commands` from `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`.
This suite does not load `.env`, initialize live providers, or write production
data. It covers submission identity, empty-isolate reads, legacy/memory-only
fallbacks, fresh cache refresh, polling terminal states/deadlines and database
validation/retry behavior, plus the Data Analyst request handlers.

Validation results: 77 command tests, 78 daily-standup tests, 143 outreach tests
and 818 voice tests passed (1,116 total). `git diff --check` passed. A full
`tsc --noEmit --incremental false` run reported 201 diagnostics elsewhere in the
repository/generated route types, with none in the changed or newly added files.
The global typecheck is therefore not green; no production build or deployment
was performed.

Deploy the API through the normal deployment process. No SQL migration or data
rewrite is required. Running requests on an older deployment can continue until
they terminate; verify a new time window after deployment and the old requests'
five-minute maximum lifetime. Expect no new `commands.id = cmd_…` errors from
these routes. Historical logs are not removed by the repair.

## Separate JSON issue

The same hour also contained 12 `invalid input syntax for type json` errors.
Two inspected samples were inserts into `public.content`, with detail
`Unicode low surrogate must follow a high surrogate.` This is a separate Unicode
payload problem, not the command UUID lookup. It is **not fixed by this change**
and needs its own producer/payload investigation.