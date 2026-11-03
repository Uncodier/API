# Requirement scheduler: created or updated scope

The active requirement scheduler admits the date scope when **either**
`created_at >= 2026-09-01 00:00:00 UTC` **or**
`updated_at >= 2026-09-01 00:00:00 UTC`. The cutoff is fixed and inclusive.
Status, ownership, holds, pauses, credit/budget checks and lease guards still apply.

The SQL change is a new forward migration:
`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261103210000_requirement_created_or_updated_scope.sql`.
It patches exactly one date predicate in the installed private agent claim function,
preserving its identity, permissions and all other logic. It fails closed if the
expected predicate is missing or duplicated; the exact repaired body is idempotent.
The command-draining/economic-recovery public wrapper is not replaced.
Historical migrations and the retired candidate scheduler remain unchanged.

Recurring terminal requirements use the same OR scope in
`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/harness/requirement-scheduler.ts`.
The forward migration was applied to **Makinari** on 2026-11-03 using the schema
repository's local PostgreSQL configuration. Its canonical/bootstrap copies and
hash manifests are synchronized there; see
`/Users/prado/Desktop/Proyectos/Uncodie/Code/makinari-db-scheme/supabase/validation/20261103210000_requirement_date_scope.md`.
The API recurrence-query change still requires normal deployment; no deployment
was performed as part of this application.
Do not rewrite customer timestamps or resubmit existing commands to force admission.

This broadens eligibility for other historical requirements with recent updates,
not just HabitUall. Review the eligible backlog before production rollout; admission
is not proof that execution, provider access or final delivery will succeed.

Offline regressions exercise the real SQL in ephemeral PGlite: both dates old,
either date exactly at the cutoff, both dates recent, and an April-created project
updated in November. They also preserve cancellation/hold/pause guards and function
identity/ACLs. Scheduler tests verify the PostgREST OR filter, due-time checks,
execution holds, invalid cron expressions and query failures. These are not live
provider execution or multi-connection contention tests.