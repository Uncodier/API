import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export type CalendarsToolParams = {
  action: 'list' | 'get' | 'update_member_calendar' | 'update_team_calendar' | 'update_service_schedule';
  query?: string;
  user_id?: string;
  calendar_id?: string;
  catalog_item_id?: string;
  site_id?: string;
  enabled?: boolean;
  timezone?: string;
  availability?: any;
  days?: any;
  event_types?: any[];
  slug?: string;
  name?: string;
  member_ids?: string[];
  duration?: number;
  buffer?: number;
  duration_minutes?: number;
  capacity?: number;
};

export function calendarsTool(current_site_id?: string) {
  return {
    name: 'calendars',
    description:
      'Find and configure team members, personal calendars/working hours, round-robin team calendars, and reservable catalog services in one tool. Use action="list" first (optional query="Mauricio") to see people, their weekly hours, team calendars, company business_hours, and bookable services. Use action="update_member_calendar" to set a person\'s hours and lunch breaks. Use action="update_team_calendar" for shared round-robin calendars. Use action="update_service_schedule" for catalog items with is_reservation=true. Do NOT use scheduling to change weekly hours — scheduling only books a specific appointment.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'update_member_calendar', 'update_team_calendar', 'update_service_schedule'],
          description:
            'list: directory of members+calendars+reservable services. get: lookup by query/user_id/catalog_item_id/calendar_id. update_member_calendar: set a person\'s working hours. update_team_calendar: upsert a round-robin calendar. update_service_schedule: upsert a catalog reservation schedule.',
        },
        query: {
          type: 'string',
          description: 'Name or email search (e.g. "Mauricio"). Used by list/get/update_member_calendar.',
        },
        user_id: { type: 'string', description: 'Team member profile UUID. Preferred for update_member_calendar after list.' },
        calendar_id: { type: 'string', description: 'Round-robin team calendar UUID' },
        catalog_item_id: { type: 'string', description: 'Reservable catalog item UUID (required for update_service_schedule)' },
        site_id: { type: 'string', description: 'Seller site UUID (defaults to current site)' },
        enabled: { type: 'boolean', description: 'Whether the personal or team calendar is bookable' },
        timezone: { type: 'string', description: 'IANA timezone (e.g. America/Mexico_City). Required for update_service_schedule.' },
        availability: {
          type: 'string',
          description:
            'JSON string of weekly hours. Keys: monday..sunday. Each day: {"enabled":true,"start":"11:00","end":"20:00","breaks":[{"start":"15:00","end":"16:00"}]}. Times are 24h HH:mm (8pm = 20:00). Lunch uses breaks.',
        },
        days: {
          type: 'string',
          description: 'Alias of availability. Same JSON weekly hours format.',
        },
        event_types: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional personal event types (title, slug, duration, buffer) stored on the member calendar.',
        },
        slug: { type: 'string', description: 'Public calendar slug' },
        name: { type: 'string', description: 'Team calendar or service schedule name' },
        member_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'User IDs in a round-robin team calendar',
        },
        duration: { type: 'number', description: 'Team calendar meeting duration in minutes (default 30)' },
        buffer: { type: 'number', description: 'Team calendar buffer minutes between meetings' },
        duration_minutes: { type: 'number', description: 'Catalog service slot length in minutes (default 60)' },
        capacity: { type: 'number', description: 'Catalog service seats per slot (default 1)' },
      },
      required: ['action'],
    },
    execute: async (args: CalendarsToolParams) => {
      const { action, availability, days, ...params } = args;

      if (action === 'get' && !params.query && !params.user_id && !params.catalog_item_id && !params.calendar_id) {
        throw new Error('get requires query, user_id, catalog_item_id, or calendar_id');
      }
      if (action === 'update_member_calendar' && !params.user_id && !params.query) {
        throw new Error('update_member_calendar requires user_id or query (person name/email)');
      }
      if (action === 'update_member_calendar' && !availability && !days && params.enabled === undefined && !params.timezone) {
        throw new Error('update_member_calendar requires availability/days, timezone, or enabled');
      }
      if (action === 'update_service_schedule' && (!params.catalog_item_id || !(availability || days) || !params.timezone)) {
        throw new Error('update_service_schedule requires catalog_item_id, timezone, and availability/days');
      }

      const parseJsonField = (value: any) => {
        if (typeof value !== 'string') return value;
        try {
          return JSON.parse(value);
        } catch {
          throw new Error('availability/days must be a JSON object string');
        }
      };

      const body = {
        action,
        ...params,
        availability: parseJsonField(availability),
        days: parseJsonField(days),
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/calendars', body, `Calendars ${action} failed`);
    },
  };
}
