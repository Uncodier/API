/**
 * Operational policies injected into every Customer Support command context.
 */
export function getCustomerSupportPolicies(): string {
  return `${getLeadRecordVerificationPolicy()}${getTaskDeduplicationPolicy()}${getLeadQualificationPolicy()}${getCommerceReservationsPolicy()}${getPromotionsPolicy()}`;
}

export const TASK_DEDUPLICATION_KEY_DESCRIPTION =
  'Stable key for this lead and underlying issue, reused across turns, retries and paraphrased titles. Include the order/study ID when available. Use different keys for legitimately distinct issues, not a generic per-lead key or a turn/command ID. The backend reuses an existing task without overwriting it; use UPDATE_TASK for new information. If omitted, only conservative content identity is used.';

export function getTaskDeduplicationPolicy(): string {
  return `
=== TASK DEDUPLICATION ===
1. BEFORE every CREATE_TASK, call GET_TASKS for this lead (tasks action="list" in the unified tool). Omit title/search and type filters, as well as assignee/user, stage and date filters: they can hide the same need under a different title or owner. Set include_completed=false and include_archived=false. Review BOTH pending and in_progress tasks, not just meetings; omit status or query both statuses separately.
2. Paginate with limit/offset until pagination.has_more=false; advance offset by the returned count and review every page. An empty/incomplete page with has_more=true is not proof of absence. The Lead Record openTasks snapshot is only a hint, never a substitute for this successful complete lookup.
3. Match the underlying need, requested outcome and order/study ID, not exact title or task type. If an open task covers the same need, use UPDATE_TASK with its task_id even if the title is paraphrased or the existing task has no deduplication_key. Preserve existing description, notes, commitments, dates, assignee and other useful information; merge new facts without erasing history, and only change fields the customer actually changed. If nothing changed, reuse the task without writing.
4. If GET_TASKS fails, times out, or any page cannot be verified, do NOT CREATE_TASK. Retry the lookup or explain that verification is unavailable; never treat a failed lookup as an empty result.
5. Only after verifying no existing task covers the need, CREATE_TASK with a deduplication_key. ${TASK_DEDUPLICATION_KEY_DESCRIPTION} Do not change the key merely because a title, date or wording changes. A retry returning an existing task is not an update: inspect it and use UPDATE_TASK to merge new information, never retry CREATE_TASK with a new key to bypass reuse. A completed task returned for the same key is still the same issue; a genuinely new issue needs its own key.
`;
}

export function getLeadRecordVerificationPolicy(): string {
  return `
=== LEAD RECORD VERIFICATION ===
Whenever a Lead ID is present, treat the Lead Record snapshot and live tool lookups as the source of truth.
1. BEFORE offering times or booking, look up this lead's existing orders, appointments, reservations, and meeting tasks (scheduling.list, reservations.list with lead_id, GET_TASKS without title/search or type filters to review all open tasks, checkout/sales).
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
1. Use catalog_commerce to find the item (use include_modifiers=true when getting an item to check for variants). For price/cost questions, call catalog_commerce action="list" first. Preserve the customer's product intent, meaningful attributes and negations in search; use the exact SKU/code when supplied. The shared search supports textual and optional semantic matching. Remove greetings, not constraints such as "sin azúcar". Do not use limit=1 when discovering items. A candidate_window count is not the complete catalog total. If degraded=true, semantic search was unavailable; do not claim no product exists from that result alone.
2. If list returns count=0 or empty items, retry immediately with a shorter term or kind="service" without search. Do not tell the customer the price is missing until a broader search also returns nothing. Quote target_sale_price and currency from the tool result — never invent a price. If result_kind="related", the tool found semantic alternatives, not confirmed matches. Clearly call them related products, verify the customer's requirements and ask before substituting, booking or selling an alternative. Never claim that a related item satisfies a dietary, safety or other required constraint just because it ranked highly.
3. CRITICAL: Variants (child items) inherit their parent's availability. If a parent is unavailable or archived, you MUST NOT offer or book its variants, even if the variant row itself appears active.
4. If the item has modifiers or variants, YOU MUST ask the user to choose them before proceeding.
5. For catalog item reservations (barbers, services, capacity): calendars list/get to resolve the catalog_item_id, THEN reservations.get_available_slots, THEN reservations.create (creates the pending sale_order). Call the tool as name="reservations" with argument action="create"|"get_available_slots" — never invent a function named reservations.create. Copy catalog_item_id from calendars/catalog_commerce (a UUID); never send catalog_item_id="unknown". Do not assume a day has free slots just because calendars shows business hours — you MUST call get_available_slots before offering times. Do not also call checkout.create_order for that same slot. Use checkout.create_payment_link with the returned order_id to charge. Mixed carts (product + slot) still use checkout.create_order. If this lead already has an active reservation, use reservations.update with that id instead of create. The tool stage loops until you return [] — finish the chain in this command. There is NO background job after WhatsApp is sent.
6. For team/person meetings, use calendars tool to find team members and scheduling to book them. If the lead already has an active appointment, use scheduling action="update" (not schedule) to move it. If calendar is null, that person is not a meeting calendar — they may be a reservable catalog service instead.
7. NEVER reply "I'm checking / te confirmo en un momento" instead of calling the next tool. If availability was not returned, call reservations.get_available_slots or scheduling.check_availability before writing the user message.
`;
}

export function getPromotionsPolicy(): string {
  return `
=== PROMOTIONS ===
The ACTIVE PROMOTIONS snapshot is a hint, not the full catalog.
1. If the customer asks about discounts, promo codes, 2x1/BOGO, or whether an item is on sale, call promotions.list (status="active") or promotions.get before answering. Do not invent a promotion that is not in the snapshot or tool result.
2. Prefer list/get with customers. create/update/delete only if the merchant explicitly asks to change a promo (requires campaign_id from the campaigns tool).
3. checkout.create_order and reservations.create automatically apply the best compatible active percent/fixed promotion. Tell the customer the discounted total only when the tool result includes applied_promotions or notification. Do not invent a discount or a promo code.
`;
}
