# Outstand comments contract

`OutstandClient.getComments` reads each requested network through the provider's
`/posts/{id}/replies` endpoint. This contract only concerns comment reads; it does
not change comment publishing or the customer-support endpoint.

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
  src/lib/integrations/outstand/__tests__/conversations.test.ts
```

These Jest tests use local fixtures and mocked `fetch`, without loading Next
configuration or contacting providers. They cover canonical precedence, raw and
empty collections, malformed envelopes, HTTP/transport failures, multi-network
failure followed by retry, and adjacent conversation-client behavior.