# Requirement cron: named sandbox without a snapshot

## Failure and recovery boundary

An existing named sandbox can return HTTP 400 / `bad_request` with the exact
message `Cannot resume sandbox: no snapshot available.` Older code swallowed
this response and tried fork/create under the occupied name, producing another
400 (duplicate name). Retrying that create cannot resolve the underlying state.

The named provisioning helper now performs explicit get/resume/create rather
than SDK `getOrCreate`, whose automatic 410 deletion bypasses application guards.
Only a typed 404 / `not_found` admits ordinary creation. Authentication, network,
callback, layout and branch-read errors propagate without provisioning.

Typed 400 missing-snapshot and 410 / `snapshot_not_found` admit one bounded
recovery only when the caller supplies current cron execution ownership. Before
retiring a shell, the helper requires:

- The exact named sandbox is stopped.
- Complete, bounded inventories show zero snapshots and no nonterminal sessions.
- A metadata re-read has the same identity, creation/update times and snapshot ID.
- Execution ownership is still current immediately before deletion and retry.

Deletion does not request orphan-snapshot deletion. A scoped audit records that
the workspace is being rebuilt from Git/spec, **not recovered from lost bytes**.
This preserves migration receipt checks; it neither approves nor applies SQL.
SDK deletion has no conditional/CAS interface, so the caller must retain the
exclusive execution lease and avoid independent sandbox mutators during recovery.

Reused sandboxes skip the cold-bootstrap checkout/reset path. Resume calls with
`syncToOrigin: false` preserve the current branch, local commits and working tree.

## Crowdrage checkpoint — 2026-10-07 UTC

Requirement `d4049bf8-21bb-48e7-8aa7-869feab35133`, instance
`76d2d675-0054-4adc-bcc1-c2717d62fdd8`:

- Production logs confirmed the exact 400 missing-snapshot response.
- The old shell `req-d4049bf8-76d2d675` was stopped with no snapshots and no active
  sessions. Both referenced snapshots returned 404; no requirement feature branch
  or persisted source archive was found. No claim of recovered source was made.
- The operator invoked the same guarded retirement while checking the original
  active workflow and database ownership. A scoped system audit was saved. No
  lease reset, requirement budget reset or migration receipt change was made.
- Original workflow `wrun_01M49X0BAPTW4844WCPHBZTA1G` completed sandbox preparation,
  generated plan `5743a54f-ee4d-4f7c-9516-849319ba04f2` and entered execution.
- The cycle then reported an unapplied proposal for
  `migrations/0001_initial_schema.sql`. That product/migration gate is separate
  from sandbox recovery and remains mandatory.
- Original workflow completed and released its lease; the next regular cron
  started `wrun_01M49YE4AX8G5TBQ67YW1X0SJ3` and reused the new sandbox successfully.

These facts prove scheduler/sandbox recovery, not a completed or deployed app.
Local source changes alone do not prove production rollout.

## API rollout

API deployment `dpl_EEUWML59XB1ScwEMH7wR6JeE6Gur` reached `READY` and was promoted
to the existing API project. The alias API confirmed `backend.makinari.com` points
to that deployment. The release used a clean `HEAD` staging archive plus only
the sandbox fixes, with no local environment files and no unrelated site-setup
or billing changes. Credentials were supplied through the environment only.
No Git commit or push was made; commit these reviewed fixes before the next
Git-driven release to avoid replacing them with the older source.

The secret-free local full build compiled and passed TypeScript, then failed
page-data collection because `GOOGLE_CLOUD_API_KEY` was absent for an unrelated
sales route. The Vercel build used the project's existing configured environment
and completed successfully. No type-check bypass was introduced.

## Offline verification

From `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`:

```sh
/opt/homebrew/opt/node@22/bin/node ./node_modules/jest/bin/jest.js \
  --config jest.harness.config.js --runInBand
/opt/homebrew/opt/node@22/bin/node ./node_modules/typescript/bin/tsc \
  --noEmit --pretty false --incremental false
```

Tests use synthetic credentials and mock clients. They cover exact error typing,
bounded retry, auth/transient preservation, stale ownership, snapshot/session
inventory, pagination, metadata changes and preservation of reused workspaces.
They do not simulate provider-side concurrent mutations or prove app delivery.

Final validation: **199 suites / 3,143 tests passed**; repository TypeScript
check and `git diff --check` passed. Production `/api/status` returned HTTP 200.