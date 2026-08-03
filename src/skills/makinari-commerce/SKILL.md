---
name: makinari-commerce
description: Use this when the user wants to list/manage products in the marketplace, create/send quotes to clients, generate payment links, or manage subscriptions, passes, and digital entitlements.
types: ['automation', 'task', 'integration']
---

# Makinari Commerce Skill

## Objective

Equip the agent with operational protocols to manage the entire commercial lifecycle: catalog visibility, buyer quotations, checkout orders with Stripe payment links, reservations, passes, subscriptions, and digital entitlements.

## Instructions

1. **Marketplace & Catalog Management**
   - Products are only visible in the marketplace if `is_marketplace_listed = true` AND `status = 'active'` AND `availability_status = 'available'`.
   - Use `catalog_commerce` to toggle `is_marketplace_listed`, `is_purchasable`, or check items.
   - For recurring plans, ensure `is_recurring = true`.
   - **Pricing:** Before using default `target_sale_price`, check if the lead/deal has an applicable price list via `price_lists`.

2. **Quotation Workflow**
   - **Draft:** Create a quote tied to a `lead_id` (and optionally `price_list_id`). Status is initially `draft`.
   - **Items:** Add items with `quotation_items`.
   - **Send:** Once items are ready, update the quote status to `sent`.
   - **Never auto-accept:** Do NOT change the status directly to `accepted`. 
   - **Convert to Order:** To let a client pay for a sent quote, use `checkout` with `action="create_order_from_quotation"`, then generate a payment link.

3. **Reservation Schedules & Slots**
   - **Reservable catalog**: Mark an item as reservable via `catalog_commerce` (`is_reservation=true`).
   - Before a reservable item can be sold, it MUST have a schedule configured via `reservation_schedules` with at least one enabled day. Keys must be lowercase english days.
   - **Slot checkout**: To book, first query `reservations` (`action="get_available_slots"`). Then call `checkout` with the slot ISO times (`reservationStart`, `reservationEnd`) on the line item. You must also provide `customer_email` or `lead_id`.
   - Do NOT confuse this with the `scheduling` tool (which is for team meetings, not product inventory).

4. **Passes & Subscriptions**
   - **Passes:** A catalog item with `digital_subtype="pass"` grants uses. Map what it can book using `pass_redeemable_items`. When a buyer books using a pass, provide the `entitlement_id` to `reservations` `create` to consume a use.
   - **Subscriptions:** Managed by the backend. Use `subscriptions` to list/read them. Use `subscription_plan_items` to map a recurring plan to the digital assets it unlocks.

5. **Checkout & Payment Links (Stripe)**
   - When charging a client:
     - 1. Create a pending order using `checkout` (`action="create_order"` or `create_order_from_quotation`). Provide `site_id` and buyer details.
     - 2. Generate a Stripe link using `checkout` (`action="create_payment_link"`) with the `order_id` you just created.
     - 3. Reply sharing the Stripe URL.
   - You CANNOT charge credit cards directly. You MUST provide the Stripe URL.
   - The order stays `pending` until the commerce Stripe webhook confirms payment. Do not invent grants or orders.
   - **Avoid legacy sales tools:** Do NOT use the `sales` or `sales-order` tools for creating purchasable checkouts. Use `checkout`.

6. **Entitlements (Digital Rights)**
   - Entitlements represent access to digital assets. They are granted automatically by webhooks upon purchase or active subscription.
   - Use `entitlements` to query a buyer's library.
   - You can mark an entitlement as `used` or `revoked`, or check its `uses_remaining`, but NEVER manually invent a grant without a real order.

## Tools

| Tool | Usage |
| --- | --- |
| `catalog_commerce` | List items, toggle marketplace listing, `is_reservation`, `is_purchasable`, `is_recurring`, or read pass configurations. |
| `price_lists` | Discover custom pricing applied to specific leads/deals. |
| `reservation_schedules` | Configure capacity and weekly windows for reservable items. |
| `reservations` | Find available slots (`get_available_slots`), or book admin slots consuming `entitlement_id`. |
| `pass_redeemable_items` | Map which reservable items a pass can be used for. |
| `quotations` & `quotation_items` | Create quotes (`draft` -> `sent`). |
| `checkout` | Create pending orders (from lines or `quotation_id`), then generate payment links. |
| `subscriptions` | Read active subscriptions for a buyer. |
| `subscription_plan_items` | Map a subscription plan to digital assets. |
| `entitlements` | View digital rights and pass uses remaining. |
| `show_artifact` | Navigate UI to `buyer_library`, `quotations`, `buyer_quotes`, `buyer_orders`, `catalog`, `reservations`. |
