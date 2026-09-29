# Isolated visitor identity PostgreSQL checks

Run from the API repository with an existing PostgreSQL **17** installation:

```sh
python3 scripts/visitor-identity-pg/run.py
```

The default binary directory is `/opt/homebrew/bin`. Set `PG17_BIN` to another
existing PG17 binary directory if needed. Python uses only its standard library.
`--syntax-only` loads the fixture and five migrations without behavioral tests.
No installation, app environment, Next.js process, build, Docker, Supabase CLI,
remote connection, live authentication, OTP delivery, or production data is used.

## Safety and evidence

- Creates a fresh `/tmp/identity-pg-*` cluster, never uses an existing database.
- Explicit `listen_addresses=''` disables TCP. A mode-0700 directory holds its
  private Unix socket. Host authentication is rejected; local trust is confined
  to this disposable cluster. Inherited `PG*` configuration is discarded.
- Sets `LC_ALL=C` for Homebrew/macOS PostgreSQL startup compatibility.
- Loads metadata-derived prerequisite tables, then the actual three existing OTP
  migrations, `20260929210000_visitor_identity_tokens.sql`, and its forward
  correction `20260929221000_identity_credential_versions.sql`. It does not modify
  any migration. Prints SHA-256 hashes of the exact locally applied snapshots.
- Uses actual SQL functions, triggers, constraints, role execution, and rollback.
  Concurrency uses independent `psql` connections and observes PostgreSQL lock
  waits before releasing explicit transactions; it is not a mocked RPC test.
- Prints each passing assertion, fails immediately on errors, and returns nonzero.
- Stops PostgreSQL and removes the cluster on success, failure, SIGINT, or SIGTERM.
  If shutdown fails, it reports the path and preserves data for investigation.
  SIGKILL or machine failure cannot execute process cleanup.
- Does not generate Python bytecode or write database artifacts into the repo.

## Coverage

`sequential.py` covers stable subject mapping across sessions and replacement
keys; no email merge; private unverified attributes; atomic mapping/redemption/
grant/session writes and injected failure rollback; exact retry expiry;
subject conflicts; wrong site/session/visitor/issuer/epoch; malformed/expired
claims; absent, revoked, expired, cross-site, or unscoped keys; active-grant key
revocation; signed material fingerprints; grant expiry caps; consumed/unused
token logout epochs; first-party support; anon/authenticated RPC and private
table read/write denial; forced RLS; service-role JWT checks; owner provisioning;
and real legacy OTP/new-lead grant denial after CRM email edits.

`concurrency.py` covers simultaneous first exchanges for one mapping, exact-token
duplicate JTI idempotency, both exchange/logout commit orders, two concurrent
logouts, both exchange/key-revocation commit orders, and tokens expiring during
key-row and identity advisory-lock waits.

`credential_versions.py` covers pending-token invalidation for lookup-only,
owner-only, scopes, expiry and status changes, reverting fields without
resurrecting tokens, metadata-only updates, caller version overrides, denied
access to the old unversioned RPC, and both credential-change/exchange lock orders.

## Fixture limitations

`fixture.sql` models relevant core columns, required fields, defaults, key-status
enum, and reported foreign keys from the read-only metadata previously captured
in `/tmp/visitor-identity-schema.json` on 2026-09-29. The metadata file is not
needed to run this fixture. The script itself never obtains remote metadata.

The checked-in migrations do not bootstrap the entire production schema.
OpenAPI metadata does not disclose all original CHECK/UNIQUE constraints,
triggers, RLS policies, privileges, function ownership, or production data.
Core API-key fixture grants deliberately isolate the provisioning trigger;
they do not model the production API-key RLS policies. Auth helpers model the
standard request-JWT settings used by the real OTP service-role assertion.
New identity and OTP objects use the actual migration definitions.

Passing this suite is PostgreSQL runtime evidence, not production rollout
approval. It does not test HTTP handlers, token signatures, SDK/browser flows,
full Supabase/PostgREST behavior, other isolation levels, crash durability,
production load, or every possible scheduler interleaving. Application JWT
verification remains required before calling these service-only SQL RPCs.