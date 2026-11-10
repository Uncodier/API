# Price-list batch creation and editing

Previously `price_lists` only supported `list` and `get`. The administrative
`tools` router now exposes `batch_create` and `batch_update`, matching the
existing catalog batch authorization and preview/execution contract.

## Access and transport

Use the `price_lists` tool in the authenticated administrative assistant's
`tools` router (`action="call"`, `name="price_lists"`, `args` containing the
JSON-encoded payload below). This is an in-process administrative operation,
not a new REST import endpoint. The host binds the authenticated user and site;
neither tool arguments nor identity headers can supply authority.

Canonical site owners or a single active owner/admin membership with effective
licensed access may preview and execute. Duplicate memberships, revoked access,
authorization lookup errors and other roles fail closed. Every operation is
rate-limited to 20 requests per site/minute, including previews.

`POST /api/agents/tools/price_lists` remains **read-only** (`list`, `get`) and
rejects both batch actions with HTTP 403, including requests carrying a service
credential, exactly like catalog's direct HTTP batch boundary. It now validates
its required site UUID and read parameters and authenticates in the handler
using the catalog private-tools read policy (verified internal service, scoped
read API key, or user bearer with effective site access). Unscoped list reads
are no longer allowed. Customer support, voice and unscoped tools do not
advertise or execute mutations. No frontend proxy or database migration is
needed for this administrative tools surface.

## Create lists with individual item prices

Preview tool arguments (replace example UUIDs with the real site/item UUIDs):

```json
{
  "action": "batch_create",
  "lists": [
    {
      "name": "Wholesale",
      "code": "WHOLESALE",
      "currency": "USD",
      "channels": ["pos", "shop"],
      "items": [
        { "catalog_item_id": "11111111-1111-4111-8111-111111111111", "unit_price": 12.5 }
      ]
    },
    { "name": "Partners", "currency": "USD" }
  ],
  "dry_run": true
}
```

Review the returned `lists` and `matched_count`, then send the same payload
with `dry_run=false` and `expected_count=2`. Creation returns a `created` array
mapping zero-based input indices to generated list UUIDs. Client-supplied IDs
are not accepted. Creation is **not idempotent**: never blindly replay a failed
or timed-out request. Generated IDs for an uncertain insert appear in
`uncertain_operation.price_list_ids` for reconciliation.

## Update selected lists

Apply common changes and prices to explicit lists:

```json
{
  "action": "batch_update",
  "price_list_ids": ["22222222-2222-4222-8222-222222222222"],
  "changes": { "is_active": true, "channels": ["pos"] },
  "items": {
    "set": [{ "catalog_item_id": "11111111-1111-4111-8111-111111111111", "unit_price": 15 }],
    "remove": ["33333333-3333-4333-8333-333333333333"]
  }
}
```

Alternatively use `updates=[{id,changes?,items?}, ...]` for different metadata
and prices per list; do not combine it with `price_list_ids`, common `changes`
or common `items`. At least one change or item operation is required per list.
The preview returns normalized `updates`, `price_list_ids` and `matched_count`.
Execute the same selection with `dry_run=false` and that `expected_count`.

Writable list properties: `name`, nullable `code`, uppercase three-letter
`currency`, `is_active`, `channels` (nonempty unique subset of `pos`, `shop`,
`marketplace`) and `is_default=false`. **Default promotion is not supported**:
setting `is_default=true` needs a separate transactional default-switch
operation and is rejected. New lists default to active, nondefault, POS-only.

`items.set` upserts only the specified `(price_list_id,catalog_item_id)` rows
using the existing unique constraint; `items.remove` deletes only the named
overrides. Other overrides and omitted metadata remain unchanged. Catalog base
prices, stock, taxes, lead assignments and other lists are never modified.
Nonnegative finite prices are accepted, including zero; downstream price
resolution may treat zero as missing and fall back to catalog prices. This API
does not change that existing checkout/resolution behavior.

## Limits and recovery

- Maximum 1000 lists and 1000 total item-price operations per request, including
  the expansion of common item operations across selected lists.
- UUIDs, duplicate list/item IDs, unknown properties, empty changes, overlapping
  set/remove IDs and invalid prices are validated before writing.
- List and catalog references must belong to the authorized site, including
  previews; legacy cross-tenant override rows are rejected before upserts.
- Reference reads and set-based writes use chunks of at most 100. Different
  per-list patches and item operations retain separate statement boundaries.
- `expected_count` protects cardinality, not concurrent value changes. Preview
  is not a lock, and IDs must still exist and belong to the site at execution.
- Requests are **not atomic across statements**. Failure stops execution and
  returns `success=false`, `atomic=false`, `completed`, `created` and
  `uncertain_operation`. A network error may occur after commit. Inspect those
  IDs and current data before retrying; no rollback or automatic retry occurs.
  The router retains this structured failure data.

The schema comes from the existing `price_lists`, `price_list_items` tables and
`uq_price_list_items_list_catalog` unique constraint. No live data was changed
or deployment performed as part of implementation.

## Offline regression tests

From the API repository:

```sh
npm exec -- jest --config jest.catalog-search.config.js --runInBand --runTestsByPath \
  __tests__/catalog/price_lists_batch.test.ts \
  __tests__/catalog/catalog_commerce_batch.test.ts
```

Tests cover validation, preview, chunking, list creation, heterogeneous price
editing, removals, tenant reference guards, actor authorization, rate limits,
HTTP denial and structured partial results through the real tools router.