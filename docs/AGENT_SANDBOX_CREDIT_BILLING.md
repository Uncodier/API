# Agent and sandbox credit billing

## Commercial policy

- One product credit represents **USD 1**.
- OpenRouter agent work costs **reported `usage.cost` × 1.25** credits.
  This is a 25% markup on provider cost (20% gross margin on the selling price,
  before payment fees, infrastructure, taxes and other expenses).
- Sandbox VMs cost **0.5 credits per active VM hour**, prorated by actual session
  time. No markup is added to this separate sandbox tariff.
- Existing search, enrichment, image, video, audio and other tool tariffs remain
  separate and unchanged. There is no general per-tool-call surcharge.

Example: a reported model cost of USD 0.04 is 0.05 product credits. Thirty minutes
of active VM time is another 0.25 credits. The combined price is 0.30 credits,
plus any separately priced tools.

## Pricing audit

The OpenRouter public catalog checked on 2026-10-14 lists `openai/gpt-6.1-sol`
standard pricing at USD 2/M prompt tokens, USD 10/M completion tokens and USD
0.10/M cached-read tokens. At 272,000 prompt tokens the published override is
USD 4/M prompt and USD 15/M completion. Flex, region-specific, Fast and Ultrafast
routes have different prices. These figures are audit context, **not hardcoded
final product prices**.

Sources:

- [Model catalog](https://openrouter.ai/api/v1/models)
- [GPT-6.1 Sol endpoints and tier overrides](https://openrouter.ai/api/v1/models/openai/gpt-6.1-sol/endpoints)
- [Reported usage/cost accounting](https://openrouter.ai/docs/guides/guides/usage-accounting)

The former final token tariff of 1 input credit/M and 20 output credits/M did not
maintain a consistent markup. The requirements harness also deducted a UTF-8
byte/output-cap estimate without settling actual usage. Those estimates are no
longer final prices. Compatibility constants may remain for admission estimates;
they must not be used to bill a completed generation.

## Model accounting boundaries

Final charges use the gateway's reported account cost, not
`cost_details.upstream_inference_cost`, token estimates, cached-token counters or
additional reasoning-token counts. Reasoning/cache/routing discounts or premiums
are already reflected by the reported total. Explicit zero cost is valid; missing,
negative or nonfinite cost is unknown and requires reconciliation.

The generation ledger has a global identity and an atomic service-only billing
RPC. Repeating the same generation settlement cannot charge it twice. A different
site or provider cost for an existing identity is rejected. Known unpaid or unknown
usage stays pending; a failed/lost RPC response never authorizes replaying inference.

Harness models reserve funds before dispatch and settle the reservation against
actual provider cost. Unused holds restore their original credit buckets rather
than creating purchased credits. Included credits from expired/revoked periods
must not be restored as a new allowance. Accepted malformed output still consumes
paid work; a pause after inference does not cancel payment. Predispatch cancellation
and confirmed provider admission rejection can release their hold. Ambiguous
provider outcomes stay pending instead of receiving a speculative refund.

The admission estimate is not a guaranteed provider quote. An expensive model,
route or tier can exceed it. Settlement collects the difference when funds are
available; otherwise it preserves the known cost pending reconciliation and
blocks fresh harness dispatch rather than undercharging or replaying inference.

Application logs are telemetry, not billing instructions. Supplying a `usage`
object through an instance log must not create another charge or let model/user
input choose a billed amount.

## Sandbox accounting boundaries

Registration binds the VM resource to a server-resolved site before create/resume.
Its registration timestamp is the rollout floor: pre-registration usage is not
retroactively billed. Re-registration does not move that floor.

Bill each provider VM session from its real start until its real stop/abort, or a
bounded observation of a still-active session. Persistent sandbox creation time,
harness execution time and tool-call counts are not VM active duration. Stopped
gaps between sessions are excluded. Observe session history through control-plane
APIs that do not resume the VM.

Tenant requirement, harness and workflow VMs are metered. Shared base-image
preparation has no tenant owner and remains platform infrastructure, not a charge
attributed to whichever tenant first requests a fork.

The database locks the resource/session and updates credits and billing progress
atomically. Cron, stop, checkpoint and resumed execution use the same accounting
boundary. Unknown provider session evidence or unavailable credits require
reconciliation; cleanup must not silently record an unconfirmed charge as settled.

Provider deletion is preceded by a durable deletion intent only after a full,
successful session-history reconciliation. Completed deletion retires the meter
without deleting its audit trail. A later 404 can confirm a recorded deletion
intent, but cannot forgive an unexplained disappearance or unpaid VM time.

## Deployment

Apply the forward migrations in order before deploying runtime code:

1. `20261014230000_openrouter_actual_cost_ledger.sql`
2. `20261014230001_agent_actual_cost_settlement.sql`
3. `20261014230002_sandbox_session_billing.sql`

Historical reservation charges are not automatically refunded: their original
bucket/actual-cost evidence was not recorded. Audit them separately; do not infer
refundable money from an estimate or reset balances.

The existing `/api/cron/maintenance/sandbox-housekeeping` job reconciles tracked
VMs as well as cleaning orphaned resources. Keep its cron authentication and SDK
project/team credentials configured server-side. No new scheduled agent task or
paid provider smoke test is needed for offline verification.

## Offline verification

Run the billing suite with `jest.billing.config.js`, harness contracts with
`jest.agent-harness.config.js`, and relevant agent adapters with
`jest.ai.config.js`. Tests must not load developer `.env` files or invoke real
inference/sandboxes. Credential-sensitive fixtures use runtime-generated synthetic
values and reserved `.test` hosts. Disposable PostgreSQL tests use private Unix
sockets and prove real concurrent charge locking without accessing Supabase.