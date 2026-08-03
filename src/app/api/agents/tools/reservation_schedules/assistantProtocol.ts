import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface ReservationSchedulesToolParams {
  action: 'list' | 'get' | 'upsert' | 'delete';
  
  id?: string;
  catalog_item_id?: string;
  site_id?: string;
  
  duration_minutes?: number;
  capacity?: number;
  timezone?: string;
  days?: any; // JSON object for Mon-Sun config
  name?: string;
  
  limit?: number;
  offset?: number;
}

export function reservationSchedulesTool(current_site_id?: string) {
  return {
    name: 'reservation_schedules',
    description:
      'Manage reservation schedules for catalog items. Use action="upsert" to configure a schedule for an item (requires catalog_item_id, timezone, days, and optionally duration_minutes, capacity). Use action="list" or "get" to read schedules. Use action="delete" to remove a schedule.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'upsert', 'delete'],
          description: 'Action to perform on reservation schedules.'
        },
        id: { type: 'string', description: 'Schedule UUID' },
        catalog_item_id: { type: 'string', description: 'The reservable catalog item UUID (required for upsert)' },
        site_id: { type: 'string', description: 'Seller site UUID' },
        duration_minutes: { type: 'number', description: 'Length of a single slot in minutes (default 60)' },
        capacity: { type: 'number', description: 'Maximum seats per slot (default 1)' },
        timezone: { type: 'string', description: 'Timezone for the schedule (e.g. America/Mexico_City)' },
        name: { type: 'string', description: 'Schedule name (optional)' },
        days: { 
          type: 'string', 
          description: 'JSON string for weekly windows. e.g. {"monday": {"enabled": true, "start": "09:00", "end": "17:00"}}. Keys must be lowercase english days: monday, tuesday, wednesday, thursday, friday, saturday, sunday.' 
        },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: ReservationSchedulesToolParams) => {
      const { action, days, ...params } = args;

      if (action === 'upsert' && (!params.catalog_item_id || !params.timezone || !days)) {
        throw new Error('Missing required fields for upsert: catalog_item_id, timezone, days');
      }
      
      if ((action === 'delete' || action === 'get') && !params.id && !params.catalog_item_id) {
        throw new Error(`Missing required field id or catalog_item_id for action ${action}`);
      }

      const body = {
        action,
        ...params,
        days: days && typeof days === 'string' ? JSON.parse(days) : days,
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/reservation_schedules', body, `Reservation Schedules ${action} failed`);
    }
  };
}