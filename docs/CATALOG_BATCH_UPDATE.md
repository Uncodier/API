# Catalog batch updates

The existing `catalog_commerce` agent tool supports `action="batch_update"`,
`resource="item"` through the administrative tools router only. It binds the
host-owned site and user scope, verifies effective access and canonical site
ownership or a single active owner/admin membership, and fails closed on
ambiguous active memberships. Effective access also requires the noncanonical
owner/admin membership to have an effective license. Other roles are denied.
Owners and admins are exempt from location restrictions in
the database ACL, but location and item tenancy are still checked.
Customer support and voice do not advertise or execute batch. The HTTP endpoint
rejects batch even with a service credential; model/body identity cannot grant
permission. Authorization is checked for previews as well as writes.

## Assign an existing tax without changing base prices

1. Resolve the existing site's tax UUID with `resource="tax", action="list"`.
2. Preview with `all_items=true`, `taxes={mode:"add", tax_ids:[taxUuid]}`.
   Supply the real site context. `dry_run` defaults to true.
3. Review `matched_count` and `item_ids`. For a 595-item catalog, execute with
   those returned `item_ids` (omit `all_items`), the same taxes,
   `expected_count=595`, and `dry_run=false`.

Tax addition preserves other attachments and skips existing ones. Removal only
detaches specified tax IDs; neither operation changes the tax definition or any
base price. No tax replacement/clear-all operation is exposed.

## Supported operational changes

- Common `changes`: name, description, active/archived status, availability,
  marketplace/POS/purchasable flags, reservation/recurring flags, cost,
  minimum/default sale price, currency, sort order, pass uses and validity.
- `inventory={location_id,quantity}` sets an absolute nonnegative quantity,
  including zero, for every selected item at an existing location on the same
  site. It does not transfer stock or modify other locations.
- `taxes={mode:"add"|"remove",tax_ids:[...]}` controls tax attachments.
- Omitted properties remain unchanged. Channel flags are independent; parent
  availability restrictions still apply to variants.

Selection is explicit IDs or `all_items=true` (including archived items and
variants), never both. Maximum 1000 items per request. Larger catalogs require
explicit batches. Unknown fields, duplicate item IDs, empty patches, invalid
values and execution without `expected_count` are rejected. There are no fuzzy
search selectors, stock increments, location creation, arbitrary metadata edits,
category/reparenting changes or per-item heterogeneous patches in this version.

## Execution and recovery

Reads are paginated; writes use chunks of 100 items. References are checked before
writes. `expected_count` detects cardinality changes, not changes to individual
values: reuse preview IDs to freeze membership. Preview is not a lock.

The request is **not transactional across statements**. On failure it stops and
returns `completed` operations with item IDs and an `uncertain_operation`; a
network error can occur after commit. Inspect current data before retrying,
especially stock and prices, to avoid overwriting intervening edits. Tax inserts
use ON CONFLICT (catalog_item_id,tax_id) DO NOTHING so concurrent additions do
not overwrite attachments or reject the remaining rows in the chunk.
The administrative executor returns failures as structured data: the router
preserves `result.completed` and `result.uncertain_operation`, with success=false.

No production catalog data is changed by installing this implementation.

Run tests from the API repository with:
`node node_modules/jest/bin/jest.js --config jest.catalog-search.config.js --runInBand`.
The real PostgreSQL conflict regression runs offline with:
`node --test __tests__/catalog/catalog-batch-tax-conflict.test.mjs`.