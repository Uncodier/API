# Outstand comments contract

`OutstandClient.getComments` reads each requested network through the provider's
`/posts/{id}/replies` endpoint. This contract only concerns comment reads; it does
not change comment publishing or the customer-support endpoint.

## On-demand LinkedIn author names

`getComments(postId, { network?, username?, resolve_author_names?: boolean }, tenantId?)`
accepts an optional `resolve_author_names` boolean. It is **never enabled by
default**: omission keeps the existing provider request unchanged, `false`
explicitly disables resolution, and only `true` opts in. The client sends this
query parameter only to LinkedIn, including when it infers and reads multiple
networks from a post. Other networks never receive the parameter.

The GET route accepts only the exact query values `true` and `false`; empty,
invalid, or repeated values return HTTP 400 before accessing the provider:

```text
GET /api/integrations/outstand/posts/{id}/comments?network=linkedin&resolve_author_names=true
```

This opt-in is for **on-demand presentation of LinkedIn author names**, not
background synchronization or profile enrichment. Do not persist resolved
LinkedIn profiles (including names and other profile fields) in **leads,
messages, or Temporal** workflow/activity inputs, outputs, history, or durable
state. Durable/background callers must omit the option or keep it `false`.
Display consumers must not copy resolved profiles into those records or other
durable storage.

The [provider documentation](https://www.outstand.so/docs/get-post-repliescomments)
limits caching of resolved LinkedIn member profiles to **at most 24 hours**;
that limit is not permission to retain them permanently in this API or its consumers.
There is **no server-side profile cache here**: opted-in LinkedIn fetches use
`cache: 'no-store'`, and GET responses with `resolve_author_names=true` include
`Cache-Control: private, no-store`, including provider-error responses. Each
on-demand read goes to the provider again; no local profile data is retained.

## Successful responses

The canonical comment collection is `data`. Selection order is:

1. Top-level `data`, when present. An empty array is authoritative.
2. A legacy `replies` array.
3. The provider's `replies.comments` array.

For example, this response preserves both the provider payload and its normalized
data without replacing normalized comments with raw comments:

```json
{
  "success": true,
  "replies": {
    "comments": [{ "id": "comment-1", "message": "Raw comment" }]
  },
  "data": [{ "id": "comment-1", "text": "Normalized comment" }]
}
```

Single-network responses retain their existing `replies` shape and provider
metadata. When `data` is absent, the supported raw collection is also exposed as
`data`, without guessing network-specific comment fields. Multi-network responses
retain the public `{ success: true, replies: [...], data: [...] }` shape; both arrays
contain the merged canonical collections in network order.

A selected collection must be an array of objects. Missing or malformed
collections fail rather than becoming empty success. In particular, malformed
top-level `data` does not fall back to raw replies. `success: false` and
`degraded: true` also fail, even if comments are present.

## Failures and retries

- Upstream HTTP 5xx errors propagate with `status: 502` and the original
  `upstreamStatus`. The existing comments route returns HTTP 502 with
  `{ error, upstream_status }`.
- Upstream HTTP 4xx errors retain their existing status mapping.
- Invalid or unsuccessful HTTP-200 comment envelopes throw `status: 502`.
- Transport errors propagate unchanged through the existing error handler.
- A failure on any network rejects the entire read. Successful sibling responses
  are not returned as partial success, so callers can retry without mistaking an
  incomplete read for a completed synchronization.

The client no longer manufactures successful empty lists with degraded metadata.

## Offline regression tests

```sh
npm test -- --runInBand --runTestsByPath \
  src/lib/integrations/outstand/__tests__/client-comments.test.ts \
  src/lib/integrations/outstand/__tests__/comments.test.ts \
  src/lib/integrations/outstand/__tests__/conversations.test.ts \
  'src/app/api/integrations/outstand/posts/[id]/comments/__tests__/route.test.ts'
```

These ESM Jest tests use local fixtures, mocked `fetch`, and a mocked route client
and `NextResponse`, without loading Next configuration or contacting providers.
They cover opt-in/default/explicit-false behavior, LinkedIn-only forwarding,
multi-network inference, strict query validation, non-cacheable responses,
canonical precedence, raw and
empty collections, malformed envelopes, HTTP/transport failures, multi-network
failure followed by retry, and adjacent conversation-client behavior.