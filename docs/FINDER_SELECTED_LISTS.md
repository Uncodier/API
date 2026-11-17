# Finder selected-list persistence

Local implementation checkpoint: November 17, 2026. Not deployed or remotely
migrated by this change.

## Authenticated contracts

- `POST /api/finder/lists`: `{site_id, name, person_ids, request_id}`.
- `POST /api/finder/lists/[id]/people`: `{site_id, person_ids, request_id}`.
- Responses: `{list: {id, site_id, name, status, total_targets, created_at}, added_count}`.

Both routes independently verify a user bearer and use that user's Supabase
client. API keys, anonymous users and supplied ownership fields are rejected.
Site/list visibility, operation capabilities and location restrictions are checked
again inside atomic security-definer RPCs; browser table writes are not granted.
There is no synchronous credit charge, provider fetch or enrichment response.
Background workflows own enrichment and its existing billing rules.

Each call accepts 1–100 opaque provider IDs matching
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`. They are not application UUIDs. Names are
trimmed, nonempty, at most 200 characters, and cannot include control characters.
JSON streams are bounded to 40,000 bytes. Unknown fields are rejected.

Clients retain their UUID `request_id` and exact payload after ambiguous failures.
Receipts are scoped to the authenticated actor across both operations. Replays
return the original added count and current list metadata; changed payloads using
the same request ID return 409. Deletion leaves a private tombstone so a retry
cannot recreate a deleted list. Distinct requests deduplicate membership through
the unique `(icp_mining_id, person_id)` constraint.

## Schema and execution boundary

Forward migration `20261117220000_finder_selected_list_members.sql` is mirrored
byte-for-byte in the web repository. It requires the existing ownership migration
and Workflows execution-checkpoint schema. Do not apply it remotely without
explicit approval and target verification.

`icp_mining_people.ordinal` is a generated BIGINT identity. Read membership in
ordinal order; gaps from deduplication/rollback are expected. Each membership
stores the verified appending actor in `created_by`. SELECT inherits visible
parent RLS and `user_can`; authenticated mutation is RPC-only. Worker processing
status and selected-member checkpoint/dispatch functions belong to the later
Workflows migration, not this persistence migration.

Creation writes only selected membership and marks
`icp_criteria.source = 'selected_people'`. A uniquely scoped role-query
placeholder satisfies the existing required relationship. Selected-aware workers
must skip provider search for this marker. Deploy the selected-aware worker and
its migration before admitting selected-only jobs; legacy workers are not safe
consumers. ICP GET returns the marker and `role_query: null` for selected-only
lists so UI loading cannot translate a placeholder into an unfiltered search.

Append locks the parent, inserts only new IDs, increments `total_targets` only
for selected-only lists, and changes completed to pending only when
`execution_active = false`. It does not reset cursor, counters, snapshot,
execution ownership, version or timestamps. The narrowly scoped definer RPC
temporarily supplies the locked execution identity to the existing guard and
restores the transaction setting afterward; it cannot take caller-supplied run
ownership. Worker checkpoints must preserve newly appended totals and distinguish
selected processing from search-exhaustion accounting.

## Offline verification

```sh
NODE_OPTIONS=--experimental-vm-modules npm exec -- jest --config jest.finder.config.js --runInBand
npm exec -- tsc --noEmit --incremental false
```

PGlite tests execute the full ownership and canonical Workflows checkpoint
migrations, including the actual execution guard, then the new migration. They
cover attribution, parent RLS, operation/location denial, idempotency, rollback,
ordered opaque IDs, active/completed fenced append and unchanged search cursors.
Queued PGlite retry tests are not proof of concurrent connections in production;
PostgreSQL advisory/row locks and uniqueness provide those invariants.