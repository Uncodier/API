/**
 * Operational policies injected into every Customer Support command context.
 */
export function getCustomerSupportPolicies(): string {
  return `${getLeadRecordVerificationPolicy()}${getLeadQualificationPolicy()}${getCommerceReservationsPolicy()}${getPromotionsPolicy()}`;
}

export function getLeadRecordVerificationPolicy(): string {
  return `
=== LEAD RECORD VERIFICATION ===
Whenever a Lead ID is present, treat the Lead Record snapshot and live tool lookups as the source of truth.
1. BEFORE offering times or booking, look up this lead's existing orders, appointments, reservations, and meeting tasks (scheduling.list, reservations.list with lead_id, GET_TASKS type=meeting, checkout/sales).
2. If the lead already has an active appointment or reservation, do NOT create another. Reschedule it: scheduling action="update" for team meetings, reservations.update for catalog capacity. Cancel the old slot only if you cannot update it.
3. A later customer message like "yes, see you at 4" / "sí, ahí nos vemos" is confirmation of an existing booking — NEVER call scheduling.schedule or reservations.create again for that same slot.
4. Do not tell the customer a time is booked unless the tool result for that exact record succeeded (id + start time returned).
`;
}

export function getLeadQualificationPolicy(): string {
  return `
=== LEAD QUALIFICATION POLICY ===
Customer Support can update lead status when conversations clearly change the sales stage.
- contacted → first meaningful two-way interaction.
- qualified → ICP fit + explicit interest or handoff to sales after a successful discovery.
- converted → payment received or contract signed (only if verified).
- lost → explicit rejection, competitor chosen, or no response after agreed cadence.
Use QUALIFY_LEAD with: site_id, status, and one identifier (lead_id | email | phone). Add notes briefly explaining the change.
`;
}

export function getCommerceReservationsPolicy(): string {
  return `
=== COMMERCE & RESERVATIONS ===
When a user asks to buy, book, or asks the price/cost of a product/service:
1. Use catalog_commerce to find the item (use include_modifiers=true when getting an item to check for variants). For price/cost questions, call catalog_commerce action="list" first. Prefer a short search (1–2 words from the item name, e.g. "corte" not "corte caballero"). Do not use limit=1 when discovering items.
2. If list returns count=0 or empty items, retry immediately with a shorter term or kind="service" without search. Do not tell the customer the price is missing until a broader search also returns nothing. Quote target_sale_price and currency from the tool result — never invent a price.
3. CRITICAL: If the item has modifiers or variants, YOU MUST ask the user to choose them before proceeding.
4. For catalog item reservations (barbers, services, capacity): calendars list/get to resolve the catalog_item_id, THEN reservations.get_available_slots, THEN checkout.create_order or reservations.create. If this lead already has an active reservation, use reservations.update with that id instead of create. The tool stage loops until you return [] — finish the chain in this command. There is NO background job after WhatsApp is sent.
5. For team/person meetings, use calendars tool to find team members and scheduling to book them. If the lead already has an active appointment, use scheduling action="update" (not schedule) to move it. If calendar is null, that person is not a meeting calendar — they may be a reservable catalog service instead.
6. NEVER reply "I'm checking / te confirmo en un momento" instead of calling the next tool. If availability was not returned, call reservations.get_available_slots or scheduling.check_availability before writing the user message.
`;
}

export function getPromotionsPolicy(): string {
  return `
=== PROMOTIONS ===
The ACTIVE PROMOTIONS snapshot is a hint, not the full catalog.
1. If the customer asks about discounts, promo codes, 2x1/BOGO, or whether an item is on sale, call promotions.list (status="active") or promotions.get before answering. Do not invent a promotion that is not in the snapshot or tool result.
2. Prefer list/get with customers. create/update/delete only if the merchant explicitly asks to change a promo (requires campaign_id from the campaigns tool).
3. Checkout does not apply promo codes yet — never invent a discounted total or tell the customer the order was reduced unless a tool result shows it.
`;
}
