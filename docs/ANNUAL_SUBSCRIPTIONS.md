# Annual platform subscriptions

## Behavior

The canonical workspace is market-fit; commercial-site pricing sends a validated
monthly/annual selection to signup. The stored tier remains `engine`, `foundry`,
or `enterprise`; `billing_interval` is `month` or `year`, not a new tier.

Annual pricing is 90% of twelve monthly payments, in USD before tax/promotions:

| Tier | Monthly | Annual | Monthly equivalent | Included credits/month |
| --- | ---: | ---: | ---: | ---: |
| Starter | $23 | $248.40 | $20.70 | 20 |
| Pro | $99 | $1,069.20 | $89.10 | 100 |
| Enterprise | $500 | $5,400 | $450 | 500 |

Addons use matching annual prices with the same 10% discount and include five
additional monthly credits each. Purchased credits, historical protected credits
and withdrawable balance are not reduced by monthly replacement.

Only a verified paid Stripe invoice establishes coverage. The immutable paid
service line, rather than the amount after discounts, establishes the tier and
monthly allowance. Zero-dollar fully discounted paid invoices are still paid;
creating a coupon never reduces included credits.

`paid_subscription_period_start/end` records covered service; monthly allowance
uses `plan_credit_period_start/end`. Annual windows are UTC anniversaries from the
original service start, with calendar month-end clamping. January 31 advances to
February 28/29 and then March 31. A missed worker run grants only the current
month; it does not accumulate missed allowances. Deduction and preflight
validation call the same renewal RPC as the daily worker.

Paid interval updates preserve the existing credit anchor and consumed window;
moving Stripe's payment anniversary cannot shorten that window to refill early.
Cancellation and subscription-ID replacement also preserve that usage boundary.
The paid invoice timestamp rejects older paid updates, and the producer verifies
current configured service before applying a subscription-update invoice.

Scheduled cancellation retains monthly allowances within paid annual coverage.
Terminal cancellation clears coverage and falls back to Toolbox once. Expired
coverage cannot grant a new paid month or retain paid tier benefits indefinitely.
Replays and same-period changes retain consumption; purchases remain usable.

## Server RPC contract

`sync_stripe_subscription_state` is service-role only. Supply `p_site_id`,
`p_customer_id`, `p_subscription_id`, `p_expected_subscription_id` (the billing ID
read **before** retrieving Stripe), and `p_status`. Optional metadata parameters:
`p_current_period_end`, `p_start_date`, `p_end_date` (timestamps, default null),
`p_auto_renew` (boolean, default true), and final `p_invoice_id` (text, default null).
Invoice-origin syncs must include the invoice ID. Under the billing lock an already
applied, identity-matching settlement suppresses **all** invoice-origin status and
metadata writes, returning `outcome: synced` with `invoice_sync_skipped: true`;
continue to settlement normally. Genuine subscription lifecycle syncs omit this
parameter so current status changes remain possible. It locks billing and returns `synced` or
`obsolete_subscription` in `outcome`; the latter is a successful no-op. A terminal
event for a different ID never rebinds it. Replacement requires an unbound or
terminal previous subscription. Do not synchronize IDs/status with unconditional
updates. Same-ID status ordering still requires current authoritative retrieval;
the expected-ID fence is not a Stripe event-version fence.
Retired IDs are also recorded atomically; old unconditional server writes that
attempt to rebind them are discarded before credit/coverage triggers run.

Synchronize status before `settle_stripe_subscription_invoice(p_invoice jsonb)`.
Settlement never writes subscription status; both the locked billing state and
the supplied current Stripe snapshot must allow active entitlement. A paid invoice
received while nonactive is still settled financially. A later verified paid retry
can apply its **stored immutable** coverage once after recovery, returning
`outcome: duplicate`, `coverage_recovered: true`, and possibly positive
`credits_granted`. Do not append application-side credits, create another payment,
or assume every duplicate grants zero. Already applied retries are no-ops;
expired/older coverage, obsolete identities, and failed invoice retries cannot
recover grants. Legacy settlements without stored verified coverage remain
fail-closed and require explicit reconciliation.

For `subscription_update`, invoice settlement also requires a separate fresh
`p_invoice.current_service` object containing `plan`, `addons_count`, and
`billing_interval`, resolved from current configured Stripe service. Its exact
tuple must match the immutable settled invoice coverage, and `coverage_verified`
must remain true as invoice-line proof. Missing or mismatched current service
returns `credit_outcome: current_service_mismatch` without granting or overwriting
coverage. This applies to initial settlement and duplicate recovery; rejection
never poisons stored proof. Retrying different invoice fields cannot bypass the
stored update reason or replace its entitlement. Create/cycle semantics are unchanged.

## Configuration and rollout

Creating local files does not change Stripe, Supabase, deployed applications or
Temporal. Do not enable annual checkout before completing this coordinated rollout:

1. Verify the existing classified-credit prerequisites in
   [BILLING_CREDIT_RESET.md](BILLING_CREDIT_RESET.md), including precision and signup
   corrections. The following migrations are pending/unapplied; apply the reviewed
   `20261007180000_annual_subscription_credit_periods.sql`, followed by
   `20261007180001_subscription_checkout_leases.sql`, once through the approved
   database-owner workflow. It adds protected coverage and replaces settlement and
   renewal functions; it does not bootstrap or guess historical paid years.
2. Create annual recurring Stripe Prices (`interval=year`, `interval_count=1`) on
   the existing products, using the amounts above in cents. Keep monthly Prices.
3. Configure server-only annual Price IDs in market-fit:
   `STRIPE_STARTER_ANNUAL_PRICE_ID`, `STRIPE_STARTUP_ANNUAL_PRICE_ID`,
   `STRIPE_ENTERPRISE_ANNUAL_PRICE_ID`, `STRIPE_ACCOUNT_ADDON_ANNUAL_PRICE_ID`.
   Use separate test/live Price IDs. Missing or mismatched prices must fail closed.
4. Deploy the coordinated API, workspace and commercial pricing changes. Existing
   worker schedule/contract need no new job; verify it uses `renew_site_plan_credits`.
5. Configure Stripe's hosted portal for supported existing-subscription changes
   and verify its new prices, proration/payment settings and webhook deliveries.
   Unsupported subscription shapes must not create a second subscription; use an
   explicit operator-assisted transition instead.
6. Verify sandbox signup, paid invoice, monthly rollover, cancellation and failed
   annual renewal. Reconcile existing annual accounts only from verified invoices;
   do not rerun the bootstrap or an additive historical renewal backfill.

## Coupons and promotion codes

Subscription Checkout enables Stripe promotion-code entry. To let a customer type
a discount, create a **Promotion Code linked to a Coupon** in Stripe. A Coupon ID
alone is not a customer-entered promotion code. Each later promotion needs no new
application calculation or deployment: Stripe manages validity, eligible products,
redemption limits, amount/percentage and duration. Configure restrictions in Stripe.

The annual 10% is built into the annual Price, so an accepted coupon discounts that
already discounted amount. Restrict promotions if this stacking is not desired.
Do not infer credits from the final charged amount, or trust payment state from a
browser redirect. Hosted existing-subscription update flows do not necessarily
offer promotion-code entry; apply those discounts through Stripe's supported portal
configuration or authorized operator workflow.

## Offline verification

From the API workspace run:

```sh
node node_modules/jest/bin/jest.js --config jest.billing.config.js --runInBand
```

The annual financial runner uses disposable PGlite, runtime-generated identities,
and no credentials or network. Existing real concurrency tests use a disposable
Unix-socket PostgreSQL cluster and never a configured database URL. UI and Stripe
producer regressions live in the respective repositories. Passing offline tests
does not prove deployment, live Price configuration or webhook subscription setup.