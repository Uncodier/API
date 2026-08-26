import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface ReservationsToolParams {
  action: 'list' | 'get' | 'get_available_slots' | 'create' | 'update';
  
  id?: string;
  reservation_id?: string;
  site_id?: string;
  catalog_item_id?: string;
  lead_id?: string;
  buyer_user_id?: string;
  owner_site_id?: string;
  entitlement_id?: string;
  
  from_date?: string; // ISO date string
  to_date?: string;   // ISO date string
  
  start_time?: string; // ISO date-time string
  end_time?: string;   // ISO date-time string
  quantity?: number;
  status?: string;
  notes?: string;
  
  limit?: number;
  offset?: number;
}

export function reservationsTool(current_site_id?: string) {
  return {
    name: 'reservations',
    description:
      'Manage capacity slots for catalog items with is_reservation=true (not for team meetings). get/update require the reservation UUID in id (alias: reservation_id) — never catalog_item_id. catalog_item_id is only for create, get_available_slots, and list. lead_id is required on create and can be reassigned on update. If get_available_slots fails, retry with the catalog_item_id from the error, then update with id and new times. Slot start/end are UTC ISO instants — copy them as-is; never append Z to a wall-clock hour (12:00 CDMX is not 12:00Z). On update, keep quantity as the real seat count (usually 1); do not send 0 to bypass capacity — the current reservation is already excluded from the slot check. Occupancy crosses the parent and all variants of the same resource. If the parent redeem_assignment_mode is round_robin, a slot is free only when at least one user_choice peer (named barber) is free.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'get_available_slots', 'create', 'update'],
          description: 'Action to perform. get/update need id (or reservation_id). create needs catalog_item_id, lead_id, start_time, end_time. get_available_slots needs catalog_item_id, from_date, to_date.'
        },
        id: { type: 'string', description: 'Reservation UUID (folio). Required for get and update. Alias of reservation_id. Never pass a catalog item UUID here.' },
        reservation_id: { type: 'string', description: 'Alias of id. Same reservation UUID. Either id or reservation_id is accepted for get/update.' },
        site_id: { type: 'string', description: 'Seller site UUID (defaults to current site)' },
        catalog_item_id: { type: 'string', description: 'Reservable catalog item UUID. Use for create, get_available_slots, and list filters. Never a reservation folio.' },
        lead_id: { type: 'string', description: 'Lead UUID. Required for create. On update, reassigns the reservation to this lead.' },
        buyer_user_id: { type: 'string', description: 'Buyer user UUID' },
        owner_site_id: { type: 'string', description: 'Owner site UUID' },
        entitlement_id: { type: 'string', description: 'Entitlement UUID to consume when booking with a pass' },
        from_date: { type: 'string', description: 'Start calendar date for slot query (YYYY-MM-DD in the schedule timezone)' },
        to_date: { type: 'string', description: 'End calendar date for slot query (YYYY-MM-DD in the schedule timezone)' },
        start_time: { type: 'string', description: 'Reservation start as UTC ISO from get_available_slots.start (do not stamp Z onto a local hour)' },
        end_time: { type: 'string', description: 'Reservation end as UTC ISO from get_available_slots.end (do not stamp Z onto a local hour)' },
        quantity: { type: 'number', description: 'Number of seats/capacity to reserve (default 1)' },
        status: { type: 'string', description: 'Status (e.g. pending, confirmed, cancelled)' },
        notes: { type: 'string', description: 'Notes' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: ReservationsToolParams) => {
      const { action, reservation_id, ...params } = args;
      const id = params.id || reservation_id;

      if (action === 'get_available_slots' && (!params.catalog_item_id || !params.from_date || !params.to_date)) {
        throw new Error('Missing required fields for get_available_slots: catalog_item_id, from_date, to_date');
      }

      if (action === 'create' && (!params.catalog_item_id || !params.lead_id || !params.start_time || !params.end_time)) {
        throw new Error('Missing required fields for create: catalog_item_id, lead_id, start_time, end_time');
      }
      
      if ((action === 'update' || action === 'get') && !id) {
        throw new Error(`Missing reservation UUID for ${action}. Pass id (alias: reservation_id).`);
      }

      const body = {
        action,
        ...params,
        id,
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/reservations', body, `Reservations ${action} failed`);
    }
  };
}
