# Outstand post deletion contract

## Endpoints

Authenticated user bearer tokens are required on both post routes. Cookie-only,
service/API-key, and middleware identity headers do not grant access.

- `DELETE /api/integrations/outstand/posts/{id}?tenant_id=UUID&delete_remote=true|false`
  defaults to `delete_remote=false`: cancel a queued post/remove its Outstand
  record, **not** the published social content.
- `DELETE /api/integrations/outstand/posts/{id}/with-content?tenant_id=UUID`
  always requests remote deletion followed by Outstand record deletion. Frontend
  content deletion must use this new path: an older API deployment returns 404
  without invoking its legacy record-only DELETE.
- `GET /api/integrations/outstand/posts/{id}?tenant_id=UUID` performs the same
  tenant/account ownership checks and returns an allowlisted post DTO, with raw
  provider errors and internal fields omitted. This read is not deletion proof.

IDs must match `[A-Za-z0-9_-]{1,200}`. A single UUID `tenant_id` is mandatory.
Unknown or duplicate query parameters fail with 400. Only exact `true`/`false`
are accepted on the optional flag; GET and `/with-content` reject that flag.
Next's automatic HEAD fallback is read-only and rejects deletion flags. Only an
explicit DELETE may enter the orchestrator; other methods are rejected with 405.

Successful DELETE returns HTTP 200:

```json
{ "success": true, "post_id": "9dyJS", "delete_remote": true }
```

The flag echoes the requested mode; scheduled/draft cancellation can therefore
return `delete_remote:true` without calling the remote endpoint. The frontend
must verify **all three fields**, including the matching ID, before removing
its local content. It must retain local content on HTTP errors, malformed JSON,
failed results, missing markers, or timeouts. This backend does not delete any
local content rows.

Failures always use `{ "success": false, "error": "Sanitized message" }`.
No raw upstream errors, credentials, or per-account payloads are returned.

| HTTP status | Meaning |
| --- | --- |
| 400 | Invalid ID/query |
| 401 | Missing, invalid, expired, or anonymous user session |
| 403 | Tenant role/capability or post/account ownership denied |
| 409 | Unsupported remote deletion, partial failure, uncertain publication, or missing ownership proof |
| 502 | Provider/transport/response failure or operation timeout |
| 503 | User/tenant authorization infrastructure unavailable |

## Authorization

The handler creates an anon-key Supabase client bearing the user's token, verifies
it with `auth.getUser`, and invokes `current_user_site_role` under that identity.
DELETE requires owner/admin **and** `user_can(p_site_id, p_command: 'delete') === true`.
GET permits the canonical site-member roles. Authorization is checked freshly,
not inferred from client tags, `X-Tenant-ID`, or a service-role client.

Outstand uses an organization-shared API key. The fetched post must match the
requested ID. Every post target must match an exact account ID, network and
username in the live, fully paginated site inventory, whose `tenant_id` must
match the authorized site. Missing/disconnected accounts, duplicate or empty
targets, changing/incomplete inventory, and conflicting tenant/site metadata
fail closed. A matching header alone is never ownership proof.

## Remote orchestration and retries

1. Fetch and authorize the post and every account before any mutation.
2. Inspect **per-account** status, not only global publication/draft/deleted flags.
   Documented `deleted` is accepted as previous remote deletion proof. `published`
   requires a platform post ID; `failed` is treated as a failed publication only
   when no publication timestamp/platform post ID contradicts it. Unknown states
   fail closed.
3. Drafts and schedules safely beyond the 75-second request window cancel using
   ordinary DELETE only. Immediate, due, mixed-pending or in-progress publication
   fails with 409; the documented API exposes no atomic pause-and-delete operation.
4. Published Instagram/TikTok (and unrecognized networks) fail before mutation;
   they cannot be remotely deleted via this contract. Supported published targets
   call `DELETE /v1/posts/{id}/remote` once.
5. Outstand `success:true` means **at least one** account succeeded. Require every
   intended published account's exact network, username and platform ID to have
   a unique `status:deleted`, `error:null` result. Missing, duplicate, foreign,
   conflicting, failed, or malformed results retain the Outstand record.
6. Only then call ordinary DELETE. Require its documented positive success
   envelope; return confirmation markers only after both stages are confirmed.

No mutation is automatically retried. The operation has a shared 70-second
deadline, aborts provider/auth requests, rejects redirects, and bounds provider
response bodies. Routes declare `maxDuration=75`; frontend timeout should exceed
this (90 seconds). An aborted request does not prove that the provider did nothing.

After remote partial success or a record-delete failure, a fresh explicit retry
can recognize per-account `deleted` status and avoid requiring it again in remote
results. Free-form "already deleted" error text is **not** evidence. The remaining
published accounts must still be confirmed; unsupported failures remain blocked.

There is no trusted durable tenant-bound deletion receipt in the current schema.
If the initial provider GET is already 404, neither local tags nor organization
membership proves ownership or remote deletion. GET/DELETE return 409 with an
instruction to retain local content and contact support. A later record DELETE
404/timeout also fails closed. Operators must verify remote state before a user
chooses a separate local-only cleanup. Do not erase the last provider record to
work around an unconfirmed partial remote deletion.

## Verification

Official provider references verified against the published docs:

- [Remote deletion](https://www.outstand.so/docs/delete-a-post-from-social-networks)
- [Post details and account status](https://www.outstand.so/docs/get-post-details)
- [Record deletion/cancellation](https://www.outstand.so/docs/delete-cancel-a-post)

Offline regression command (no real providers, builds, deployment, or migrations):

```sh
npm test -- --runInBand --runTestsByPath \
  src/lib/integrations/outstand/__tests__/post-request.test.ts \
  src/lib/integrations/outstand/__tests__/post-deletion.test.ts \
  'src/app/api/integrations/outstand/posts/[id]/__tests__/route.test.ts'
```