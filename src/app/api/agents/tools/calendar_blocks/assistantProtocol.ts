import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface CalendarBlocksToolParams {
  action: 'create';
  site_id?: string;
  entity_type: 'catalog_item' | 'user' | 'global';
  entity_id?: string;
  start_time: string; // ISO date-time string
  end_time: string;   // ISO date-time string
  reason?: string;
}

export function calendarBlocksTool(current_site_id?: string) {
  return {
    name: 'block_calendar_time',
    description:
      'Block time in the calendar to prevent reservations. Use this to schedule vacations, maintenance, holidays, or any administrative blocks. entity_type can be "catalog_item" (to block a specific service), "user" (to block a staff member), or "global" (to block the entire site).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create'],
          description: 'Action to perform.'
        },
        site_id: { type: 'string', description: 'Seller site UUID (defaults to current site)' },
        entity_type: { 
          type: 'string', 
          enum: ['catalog_item', 'user', 'global'],
          description: 'The type of entity to block. Use "global" to block the entire site.' 
        },
        entity_id: { type: 'string', description: 'The UUID of the catalog_item or user (required if entity_type is not "global")' },
        start_time: { type: 'string', description: 'Start time of the block (ISO datetime string)' },
        end_time: { type: 'string', description: 'End time of the block (ISO datetime string)' },
        reason: { type: 'string', description: 'Reason for the block (e.g. "Vacations", "Maintenance")' },
      },
      required: ['action', 'entity_type', 'start_time', 'end_time'],
    },
    execute: async (args: CalendarBlocksToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        if (!params.start_time || !params.end_time) {
          throw new Error('Missing required fields: start_time, end_time');
        }
        if (params.entity_type !== 'global' && !params.entity_id) {
          throw new Error('entity_id is required when entity_type is not "global"');
        }
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/calendar_blocks', body, `Calendar Blocks ${action} failed`);
    }
  };
}
