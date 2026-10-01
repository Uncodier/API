# Outreach execution times

Both `settings.activities.leads_follow_up` and `leads_initial_cold_outreach` accept
`start_time_mode: "business_opening" | "custom"` and custom `start_time: "HH:mm"`.
The UI exposes the same choice for Daily Standup, whose execution checks live in
the Workflows configuration activities.

Custom time is strict 24-hour format and required in custom mode. Invalid modes
and custom values defer generation/delivery. Opening mode ignores stale times
retained by settings merges. Historical times without a mode are custom; missing
both fields keeps historical runtime behavior until a choice is saved.

Outreach uses the first business-hours entry or legacy object, its IANA timezone
(America/Mexico_City fallback), and `days[weekday]`/`[weekday]` with `start`/`open`.
Opening skips explicitly disabled days and falls back to 09:00 for unavailable
openings. Cold Outreach uses business operating days in both modes, with missing
entries eligible Monday–Friday. Follow Up keeps its selected weekdays; custom
time can run on explicitly selected closed days. Times are inclusive start floors,
not closing cutoffs, and match Workflows' per-day scheduler semantics.

The central delivery guard defers before transport preparation and reservation,
and reloads preferences after preparation to catch a later start or opening-mode
reset. Generation also checks timing. Existing account, audience, consent, cap,
idempotency and tenant guards remain in place; timing never enables an activity.

Deploy API support before the compatible Workflows worker and UI. No database
migration, production setting rewrite, deployment or real send is required for
local tests. Run `node node_modules/jest/bin/jest.js --runInBand
src/lib/services/outreach/__tests__` with the existing local Jest configuration.