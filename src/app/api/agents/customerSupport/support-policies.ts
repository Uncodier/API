/**
 * Operational policies injected into every Customer Support command context.
 */
export function getCustomerSupportPolicies(): string {
  return `${getLeadRecordVerificationPolicy()}${getLeadQualificationPolicy()}${getCommerceReservationsPolicy()}`;
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
When a user asks to buy or book a product/service:
1. Use catalog_commerce to find the item (use include_modifiers=true when getting an item to check for variants).
2. CRITICAL: If the item has modifiers or variants, YOU MUST ask the user to choose them before proceeding.
3. For catalog item reservations (barbers, services, capacity): calendars list/get to resolve the catalog_item_id, THEN reservations.get_available_slots, THEN checkout.create_order or reservations.create. If this lead already has an active reservation, use reservations.update with that id instead of create. The tool stage loops until you return [] — finish the chain in this command. There is NO background job after WhatsApp is sent.
4. For team/person meetings, use calendars tool to find team members and scheduling to book them. If the lead already has an active appointment, use scheduling action="update" (not schedule) to move it. If calendar is null, that person is not a meeting calendar — they may be a reservable catalog service instead.
5. NEVER reply "I'm checking / te confirmo en un momento" instead of calling the next tool. If availability was not returned, call reservations.get_available_slots or scheduling.check_availability before writing the user message.
`;
}
