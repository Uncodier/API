# Agent checkout: exclusive catalog taxes

Agent checkout (including reservations and quotation conversion using the same
order creator) now loads active taxes attached to every resolved product and
modifier. Prices and overrides are **before tax**. Do not add IVA manually to an
override. This follows `market-fit/app/commerce/taxes.ts`: rates are additive,
tax is rounded to two decimals per line, then summed and rounded again.

Matching the existing application checkout, promotion discounts are subtracted
after computing taxes on line subtotals: 100 + 16 IVA - 10 promotion = 106.
This change does not introduce a different discount-tax policy.

`sale_orders` stores `subtotal`, `tax_total`, `discount_total`, and `total`.
The new sale's `amount` and `amount_due` equal the final payable total. Tool
results include `tax_total`. A failed tax lookup, invalid rate, foreign tax
association, or mixed-currency order prevents order creation rather than
silently charging zero tax or adding unrelated currencies.

Stripe links use the stored amounts, add tax/shipping lines, and apply the exact
stored discount. Item sums and final totals must reconcile before contacting
Stripe. Order totals use two-decimal money. Catalog unit prices retain their
precision and quantities may be fractional: Stripe receives a quantity-one line
for the extended amount when its integer quantities/cent prices cannot represent
the original line. Cumulative cent allocation preserves the rounded subtotal.
More than 100 payment lines are consolidated into merchandise, tax and shipping,
without modifying the original order lines or discounts.
Automatic Stripe taxes are disabled to avoid charging tax twice.

Tax is computed on the unrounded unit-price × quantity subtotal and then rounded
per line. The aggregate merchandise subtotal is rounded separately, matching
the same-currency application checkout. A base of 0.034 with IVA 16% therefore
has 0.01 tax and a payable unit preview of 0.04, not 0.03.

Idempotent replay uses the original stored tax/total, not current catalog rates.
Existing orders and existing payment sessions are not retroactively repriced.
Review/reissue old unpaid orders through the normal order workflow if they were
created before taxes were included; do not silently change an agreed total.

Tests: `node node_modules/jest/bin/jest.js --config jest.checkout.config.js --runInBand`.

## Catalog queries

`catalog_commerce` item list, search and get always return `item.pricing` (or
`items[].pricing`), without requiring `include_taxes`. For a base price of 100
MXN with active IVA 16%, this contains:

```json
{
  "status": "available",
  "currency": "MXN",
  "base_price": 100,
  "base_price_includes_tax": false,
  "active_taxes": [{ "id": "tax-id", "name": "IVA", "rate": 16 }],
  "unit_tax_amount": 16,
  "unit_price_with_tax": 116,
  "scope": "one_unit_before_promotions_shipping_and_modifiers"
}
```

The agent should quote `unit_price_with_tax`, not `target_sale_price`, and never
add tax twice. Checkout and query previews share the same active-tax loader and
line rounding function. Missing/invalid prices or missing currency return
`status=unavailable` with null computed amounts, not a fabricated free price.
Tax lookup failures fail the query rather than misrepresenting it as tax-free.
The price is a unit preview, not a committed quote: quantities, modifiers,
promotions and shipping must be finalized by checkout. Existing optional
`include_taxes` still returns raw tax associations separately for management.