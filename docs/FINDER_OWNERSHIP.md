# Finder list ownership

Finder `person_role_search/createQuery` and `icp` GET/DELETE require a verified,
nonanonymous authenticated user bearer. Service keys and client/middleware
identity headers are not accepted as a user identity.

Create checks site visibility, list ownership access, insert capability, both
global and site location restrictions, and any supplied segment's user-scoped
visibility within the same site before billing or service-role writes. A segment
is optional. Shared role queries and their segment links are not per-list data.

The API assigns `icp_mining.user_id` and criteria `user_id` from the verified
actor. Query metadata is stripped. Active and race lookups filter exact JSONB
criteria, site, and actor. Exact JSONB equality avoids the known mismatch between
JavaScript JSON serialization and PostgreSQL's generated JSONB text hash; the
database's generated hash still enforces active uniqueness.

GET first reads the list with the user's RLS client, then loads its shared role
query with the admin client. DELETE checks visible list and delete capability,
then deletes with the user client so operation-specific and location policies
are rechecked at mutation time. Raw database errors are not returned.

## Migration and remaining attribution boundary

`supabase/migrations/20261117203000_finder_list_ownership.sql` mirrors the same
migration in the frontend repository; it is one migration, not two independent
operations. It adds nullable `user_id`, an `auth.uid()` default, attribution
guards and restrictive ownership policies without removing location guards or
inferring historical creators. The coordinating agent applied this exact migration
to Makinari (`rnjgeloamtszdjplmqxy`) at 2026-11-17 20:19:58 UTC with explicit approval.
The affected assigned-only member is allowed for self attribution and denied for
foreign/null creators. Eight historical site lists remain unattributed and hidden;
no creator was inferred and no business row was rewritten. This API implementation
still requires deployment before new Finder lists reliably attribute their caller.

The unchanged `src/lib/services/finder/create-icp-mining.ts` service-role helper,
used by `agents/tools/createIcpMining` route/assistant protocol, still creates
unattributed rows: a service-role call has no user `auth.uid()` default. Those
rows fail closed for assigned-only members; owners/coowners and unrestricted
authorized active members retain the specified site-wide visibility. No actor
is fabricated from site ownership, shared query or segment links. This work does
not secure or attribute the separate agent-tool path.

## Local regression command

```sh
npm test -- --config jest.finder.config.js --runInBand
```

The focused Jest suites include route ordering/error/dedup tests, verified bearer
and segment/location preflight tests, and an offline PGlite migration/RLS test.

Use the explicit `jest.finder.config.js` configuration for these suites. It uses
the existing repository pattern from `jest.deals.config.js`: CommonJS `ts-jest`
transformation for hoisted `jest.mock` factories. The default `jest.config.js`
uses ESM transformation and cannot run these CommonJS mock factories; running
only `npm test -- --runInBand <test-path>` reproduces `jest.fn is not a function`.
The passing result above applies to the explicit Finder configuration, not the
default runner. No global Jest configuration or production code is changed to
work around this difference.

Actual suite paths (route tests are colocated with the Finder service tests,
not beneath the route directories):

- `src/lib/services/finder/__tests__/routes.test.ts` imports and tests
  `person_role_search/createQuery/route.ts` POST and `icp/route.ts` GET/DELETE.
- `src/lib/services/finder/__tests__/ownership.test.ts` tests authentication and
  authorization preflight helpers.
- `src/lib/services/finder/__tests__/migration.test.ts` tests the SQL migration
  and RLS offline using PGlite.

To run only the authentication/preflight suite:

```sh
npm test -- --config jest.finder.config.js --runInBand src/lib/services/finder/__tests__/ownership.test.ts
```