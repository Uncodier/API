# NEX CARGO registration repair — 2026-09-28

## Scope and verified causes

Requirement `5a1d6caa-92a4-420d-80f2-567392a1af11`, instance
`dc06757e-5570-485c-9948-cf5bb9179ae8`.

1. Tenant migration owner lacked `USAGE` on managed `auth`. The available
   Supabase `postgres` actor cannot grant it: a transaction-scoped GRANT probe
   still returned false and was rolled back. Do not grant membership in
   `authenticated` or `service_role` as a workaround.
2. The driver contract sends nested `vehicle`, while the route read flat fields.
   The old route would also fail RLS, since it inserted random user IDs with an
   authenticated backend token and performed two non-atomic inserts.
3. The injected tenant token was signed with the wrong secret. In-memory HMAC
   comparisons against Apps configuration verified the legacy anon token but
   not the tenant token. Correcting the API signer environment and regenerating
   the same scoped tenant claims fixed PostgREST PGRST301. No Supabase key rotation,
   global JWT policy change or service-role key exposure was performed.
4. After product budget exhaustion the workflow treated a cancelled step like a
   successful turn, then masked the failure with a generic ownership retry error.

## Applied Apps changes

The original NEX schema was never applied: only `_meta` existed. Its replacement
was executed through `apps_apply_migration` using the Management migration API:

- `migration:supabase/migrations/0001_initial_schema.sql`
  checksum `ca06fbaed6510fc4eb2006d6e6d7838bcbebb1a7a61ad312a7de8db167743a90`
- `migration:supabase/migrations/0002_pin_registration_function_search_path.sql`
  checksum `92823c2842ac3156c365e1298c9f4a9fcab23d9b9daaed0ed0232c8249234648`

Exact copies are under `supabase/tenant-migrations/app_5a1d6caa92a4420d80f25673/`.
These files are now immutable. Future changes require a new migration.

The four app tables all enable RLS. Tenant-local `current_user_id` and
`request_claims` are SECURITY INVOKER equivalents of Supabase's read-only claim
helpers; they do not set claims or bypass signature verification. All application
functions have fixed search paths. No changes were made to another tenant.

`register_driver` requires the exact backend subject plus signed tenant/schema
claims. It validates input, serializes a tenant-local 50 registrations/minute
limit, inserts name/profile plus owned vehicle atomically, rejects conflicting
duplicate email/plate, and returns the same IDs on an exact repeated request.
User self-assignment/update of roles is not permitted. Registration is intake,
**not a verified Supabase Auth account**; do not infer authenticated email ownership.

## Published application

Repository `makinary/apps`, branch
`feature/req-5a1d6caa-92a4-420d-80f2-567392a1af11`.

- Previous commit: `27b7310079d566f700ecb9e851ff8469d7597e80`.
- Repair commit: `d5dd61b0ae10e7b2b4202a607db294e57c6d8503` (11 files).
- Preview: https://apps-r9bq364d9-uncodie.vercel.app

Shared normalization accepts nested contract and legacy flat form fields, validates
positive kg capacity and rejects malformed input. Only a verified two-UUID RPC
receipt returns 201. Errors are sanitized; unavailable backend configuration fails
503. The proxy exception is restricted to the registration page and exact endpoint.
The named sandbox was synchronized without dropping the existing evidence file.

Verified real production build (exit 0), preview page 200, POST 201 with persisted
linked rows, exact retry 201 with identical IDs, invalid capacity 400. App tests:
5 suites / 144 tests plus targeted TypeScript and ESLint checks.

## API/harness repair

Cancelled product turns stop before success-clear and delivery effects. Primary
HTTP/quarantine evidence survives secondary errors. Ownership checks remain strict;
structured bounded diagnostics and FatalError preserve the rejection reason instead
of an uninformative retry wrapper. Same-generation pauses are respected in cleanup.

Offline API suite: 114 suites / 1,041 tests passed at this checkpoint. The repository
typecheck has unrelated pre-existing failures; touched harness files have no errors.

## Operator-required global ACL repair

`supabase/migrations/20260928235000_apps_tenant_auth_helper_usage.sql` is deliberately
**not applied**. It checks grant authority for both installer and the retained
`apps_ensure_tenant` owner, backfills the 178 registered isolated owners, and updates
future provisioning with post-grant checks. Available `postgres` lacks that
authority. Arrange supported auth-schema grant authority with Supabase before
applying. Offline PGlite tests cover 178 owners, ACL isolation and atomic failures.

Existing unrelated Apps advisor findings remain (including privileged public RPCs).
Review them separately; do not broaden tenant grants to compensate:
https://supabase.com/docs/guides/database/database-linter