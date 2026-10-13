# Voice scheduling: live dates, calendars and recovery

## Behavior

- `get_call_context` supplies a fresh server clock on every call: `current_time_utc`,
  `local_date`, `tomorrow` and the site's resolved `timezone`. Historical interaction
  dates and the last agent synchronization date are not clock sources.
- `scheduling.check_availability` accepts `calendar_id` from `calendars.list`,
  `user_id` for an enabled personal calendar, or legacy `team_id` as an alias of
  `calendar_id`. An agent ID is never a calendar ID.
- Without a target, only a unique enabled team calendar (or, if none exists, a
  unique enabled personal calendar) can be selected. Invalid explicit targets are
  rejected rather than silently replaced.
- Team calendars come from `settings.calendars`; membership is verified against
  `site_ownership`/`site_members`. Legacy email references resolve only to a unique
  profile in that site. Responses expose profile IDs, not internal emails.
- Availability intersects business and personal hours in their own timezones,
  excludes breaks, elapsed slots, confirmed overlapping `appointments`, calendar
  buffers, global blocks and individual `calendar_blocks`. No `teams` or meeting
  columns on `tasks` are used. Missing schedules or failed occupancy reads fail
  closed; reservable catalog resources still use `reservations`.
- A free team slot offers one or more eligible participants, not a booking.
  Choose a returned participant for round-robin, copy `start_utc` unchanged, and
  check the caller's current appointments before creating another one.

## Failure contract

Availability errors retain their HTTP status and return `success: false`, a safe
`code`/`error`, and `recovery` with the server clock and three future
`suggested_dates`. Those dates are **not verified availability**. The agent must
confirm a date, resolve the correct calendar and check availability again.

The scheduling-only HTTP transport has a bounded 5.5-second wait. It preserves
structured recovery and creates safe recovery for network failures, timeouts or
malformed responses without exposing raw upstream errors. Recoverable executions
are returned through the authenticated voice webhook as HTTP 200 with
`success: false` so the voice model receives the guidance; logs mark these as
`execution_recovery`, not successful booking. Authentication/authorization and
input rejection retain error status.

Failed create/update requests may have committed before the connection failed.
They are never automatically retried. Their recovery explicitly requires listing
the caller's appointments before considering another write.

## Validation and rollout

- `npm run test:scheduling`
- `npm run test:voice`
- `node ./node_modules/typescript/bin/tsc --noEmit --incremental false`

Deploy the API changes, then use the existing voice configuration synchronization
to refresh the provider's tool schemas and runtime prompt. The live clock and
fallback responses take effect in the API without embedding a synchronization-time
date. No database migration or historical conversation rewrite is required.

This change does not create a distributed booking lock. Concurrent reservations
still require a separate transactional concurrency design; slot checks alone are
not a guarantee against simultaneous writes.