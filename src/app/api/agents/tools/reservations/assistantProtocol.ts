import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface ReservationsToolParams {
  action: 'list' | 'get' | 'get_available_slots' | 'create' | 'update';
  
  id?: string;
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
      'Manage capacity slots for catalog items with is_reservation=true (not for team meetings). catalog_item_id is a catalog UUID only — never a reservation folio. Reservation UUID goes in id (get/update). If get_available_slots fails, retry with the catalog_item_id from the error, then update with the reservation id and new times.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'get_available_slots', 'create', 'update'],
          description: 'Action to perform.'
        },
        id: { type: 'string', description: 'Reservation UUID (folio). Use for get and update. Never pass this as catalog_item_id.' },
        site_id: { type: 'string', description: 'Seller site UUID (defaults to current site)' },
        catalog_item_id: { type: 'string', description: 'Reservable catalog item UUID (not a reservation id)' },
        lead_id: { type: 'string', description: 'Lead UUID attached to the reservation' },
        buyer_user_id: { type: 'string', description: 'Buyer user UUID' },
        owner_site_id: { type: 'string', description: 'Owner site UUID' },
        entitlement_id: { type: 'string', description: 'Entitlement UUID to consume when booking with a pass' },
        from_date: { type: 'string', description: 'Start date for slot query (ISO string, e.g. 2026-07-27)' },
        to_date: { type: 'string', description: 'End date for slot query (ISO string)' },
        start_time: { type: 'string', description: 'Start time of the reservation (ISO datetime string)' },
        end_time: { type: 'string', description: 'End time of the reservation (ISO datetime string)' },
        quantity: { type: 'number', description: 'Number of seats/capacity to reserve (default 1)' },
        status: { type: 'string', description: 'Status (e.g. pending, confirmed, cancelled)' },
        notes: { type: 'string', description: 'Notes' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: ReservationsToolParams) => {
      const { action, ...params } = args;

      if (action === 'get_available_slots' && (!params.catalog_item_id || !params.from_date || !params.to_date)) {
        throw new Error('Missing required fields for get_available_slots: catalog_item_id, from_date, to_date');
      }

      if (action === 'create' && (!params.catalog_item_id || !params.lead_id || !params.start_time || !params.end_time)) {
        throw new Error('Missing required fields for create: catalog_item_id, lead_id, start_time, end_time');
      }
      
      if ((action === 'update' || action === 'get') && !params.id) {
        throw new Error(`Missing required field id for action ${action}`);
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/reservations', body, `Reservations ${action} failed`);
    }
  };
}