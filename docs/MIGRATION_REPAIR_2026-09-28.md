# Bounded tenant migration repair — 2026-09-28

## Harness change

- Supabase skill SQL examples are tested against the real tenant linter. Static
  tenant SQL, ownership/membership RLS, protected membership writes and immutable
  applied migrations are the contract. Public intake is not an open table policy.
- The applier returns a typed repair target only after confirming the migration
  is unapplied. Lint/SQL defects are product failures; checksum drift, permissions,
  unavailable ledger or schema exposure failures never authorize automatic edits.
- The app/site workflow can spend at most five extra single-tool turns (bounded
  by the flow turn limit) in the same cycle. This budget is shared across files.
  Exhaustion remains blocked; it is not an unbounded infrastructure retry.
- The repair agent has only context-read and pending-SQL-replacement tools. No
  shell, push, direct database SQL, arbitrary file writes or ledger mutation.
  Replacement rechecks tenant identity, the protected ledger, original checksum,
  canonical file path and ownership. It passes the existing linter before writing.
- Automatic replacement is deliberately conservative: non-policy statements
  remain unchanged and existing policy names/table targets, commands and roles
  must survive. Dynamic SQL, structural changes, data backfills, policy removal and ambiguous access
  semantics require operator review. No privilege escalation is granted to bypass
  a lint error. The lexical checks are defense-in-depth, not a SQL semantic proof.
- A write produces a verified checksum, not an applied receipt. Revalidation must
  find the repaired files with those checksums even after sandbox recovery, then
  pass normal atomic migration application. Fresh product verification runs after
  successful repair; old product evidence cannot approve changed authorization.
- The LLM/write durable step has automatic replay disabled (`maxRetries = 0`).
  Ambiguous errors retain the effective sandbox for cleanup and keep delivery
  failed. Existing execution ownership, atomic migration ledger and delivery gates
  are retained. Cross-process writes outside the workflow remain subject to the
  existing checksum checks; filesystem/ledger checks are not a distributed lock.

## Production investigation (read-only)

No tenant data, migration receipts, GitHub branches, sandbox files, or requirement
statuses were changed as part of this repair. The API change still needs deployment.

### NEX CARGO

- Requirement: `5a1d6caa-92a4-420d-80f2-567392a1af11`.
- Instance: `dc06757e-5570-485c-9948-cf5bb9179ae8`.
- Tenant exists; only `_meta`, no applied app migration.
- Initial SQL opens users/vehicles/loads/bids reads and anonymous loads inserts.
- Canonical source at commit `a69f7583179078db2e802372e120334aaacad090`
  has a stub `POST /api/loads/request`: it returns 201 without persistence.
  Its specification explicitly requires intake without registration. The public
  Supabase client alone cannot become an authorized server-side intake capability.
- Safe follow-up: owner/membership schema plus a narrow authorized intake path,
  payload validation/abuse controls, and real anonymous persistence tests. Do not
  silently change the product contract to require login or call a stub "delivered".

### Visualgv

- Requirement: `7f146ebd-26a8-4d47-8ce5-f17d454be1da`.
- Instance: `45e593d5-896a-4652-8187-c327a377efd7`.
- All 15 applied `supabase/migrations` files through `0015` match ledger checksums
  at source commit `e38b416713c17c085ed7d84e88f2a94785d1ca3e`; preserve them.
- Fifteen later SQL files are pending. Several use cross-schema dynamic DDL,
  unconditional policies, or global Storage writes. Appending another migration
  after them does not unblock the first failure.
- There are 530 existing campaigns without `user_id` / `organization_id`. The API
  also expects missing `description` / `budget` columns. Assigning an arbitrary
  owner or applying creator-only access would hide data and violate org RBAC.
- User membership/role writes are insufficiently protected; the invoker role
  helper can recurse through users RLS. Establish trusted membership and an
  approved legacy ownership/org mapping before replacing campaign permissions.
- The expected tenant Storage bucket is missing and app code hardcodes `assets`.
  Provision storage through the platform, not tenant SQL targeting storage tables.
- `mode=test`/curl paths return synthetic successes; mocked tests are not runtime
  proof of persistence or authorization. Remove those shortcuts in coordinated
  application repair and test anon, unrelated user, authorized role and cross-org.

## Validation / rollout

Run `npm run test:harness` from `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`.
The suite covers guidance, linter, repair policy/tools, ownership, bounded workflow
attempts, ambiguous errors and recovered-file loss. It performs no production I/O.

Local validation: **111 suites / 1,008 tests passed**, including execution of the
new RPC SQL in in-memory PGlite with service-role/anon/authenticated permission
checks. Repository-wide TypeScript reports 212 errors outside the changed files;
no TypeScript errors were reported in the files changed for this repair. This is
not a claim of a successful production build or a live sandbox end-to-end test.

Apply `supabase/migrations/20260928223000_apps_pending_migration_repair_check.sql`
to **Apps**, then deploy the API and canary one scoped repair. The service-role-only
lookup prevents treating renamed applied SQL as a pending repair. Missing RPC
fails closed. Neither this migration nor the API has been deployed by this task.
Keep the two requirements blocked until their coordinated SQL/application
repairs and access decisions are complete. Never clear blockers merely because the
harness tests pass, and do not replay an already-applied file with a different hash.