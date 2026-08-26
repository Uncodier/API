import { fetchApiTool, fetchApiToolGet } from '@/app/api/agents/tools/utils/fetch-helper';
/**
 * Assistant Protocol Wrapper for Scheduling Tool
 * Unified tool for scheduling (check_availability, schedule, list, update)
 */

export interface SchedulingToolParams {
  action: 'check_availability' | 'schedule' | 'list' | 'update';

  // check_availability params
  date?: string;
  duration?: number;
  timezone?: string;
  team_id?: string;
  start_time?: string;
  end_time?: string;
  participants?: string[] | string;
  resources?: string[] | string;

  // schedule / update params
  title?: string;
  start_datetime?: string;
  context_id?: string;
  lead_id?: string;
  location?: string;
  description?: string;
  reminder?: number | string;
  appointment_id?: string;
  id?: string;
  status?: string;
  limit?: number;
}

function asParticipantArray(value?: string[] | string): string[] | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? value.split(',').map((p) => p.trim()).filter(Boolean) : value;
}

export function schedulingTool(site_id: string, _instance_id?: string) {
  return {
    name: 'scheduling',
    description:
      'Book, list, or reschedule a specific team/person appointment (not weekly hours, not catalog inventory). To find people or SET working hours/lunch, use the calendars tool instead. Use action="check_availability" to get available slots (requires date, duration, timezone, team_id). Use action="list" with context_id/lead_id BEFORE booking so you do not create a duplicate. Use action="schedule" only when the lead has no active appointment (requires title, start_datetime, duration, timezone, context_id). Use action="update" to move or cancel an existing appointment (requires appointment_id). Slot start_utc/end_utc are UTC instants — copy start_utc as start_datetime; never append Z to a wall-clock hour (12:00 CDMX is not 12:00Z).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check_availability', 'schedule', 'list', 'update'],
          description: 'Action to perform: check_availability, schedule, list, or update.',
        },
        date: { type: 'string', description: 'Local calendar date YYYY-MM-DD (check_availability and list). Filtered in timezone, not UTC midnight.' },
        duration: { type: 'number', description: 'Meeting duration in minutes (min 15 for check, min 5 for schedule/update)' },
        timezone: { type: 'string', description: 'IANA timezone for wall-clock hours (e.g. America/Mexico_City). Required for check_availability/schedule; used with date on list so "hoy" is the client day, not UTC.' },
        team_id: { type: 'string', description: 'Team UUID (required for check_availability)' },
        start_time: { type: 'string', description: 'Day start time (default 09:00)' },
        end_time: { type: 'string', description: 'Day end time (default 17:00)' },
        participants: {
          type: 'string',
          description: 'Participant IDs to check availability (comma-separated string)',
        },
        resources: {
          type: 'string',
          description: 'Resource IDs (comma-separated string)',
        },
        title: { type: 'string', description: 'Appointment title' },
        start_datetime: { type: 'string', description: 'Start as UTC ISO from check_availability.start_utc, or naive wall-clock in timezone (do not stamp Z onto a local hour)' },
        context_id: { type: 'string', description: 'Context ID (lead_id). Required for schedule; used as filter for list.' },
        lead_id: { type: 'string', description: 'Alias of context_id for list/schedule. Prefer the current Lead ID.' },
        location: { type: 'string', description: 'Location' },
        description: { type: 'string', description: 'Description' },
        reminder: { type: 'number', description: 'Reminder minutes before' },
        appointment_id: { type: 'string', description: 'Existing appointment UUID. Required for update.' },
        id: { type: 'string', description: 'Alias of appointment_id for update.' },
        status: { type: 'string', description: 'Filter (list) or new status (update). Use cancelled to cancel.' },
        limit: { type: 'number', description: 'Max appointments to return for list (default 50)' },
      },
      required: ['action'],
    },
    execute: async (args: SchedulingToolParams) => {
      const { action, ...params } = args;

      if (action === 'check_availability') {
        if (!params.date || !params.duration || !params.timezone || !params.team_id) {
          throw new Error('Missing required fields for check_availability: date, duration, timezone, team_id');
        }

        const urlParams = new URLSearchParams({
          date: params.date,
          duration: String(params.duration),
          timezone: params.timezone,
          team_id: params.team_id,
          site_id: site_id,
        });
        if (params.start_time) urlParams.set('start_time', params.start_time);
        if (params.end_time) urlParams.set('end_time', params.end_time);

        const participantsArray = asParticipantArray(params.participants);
        if (participantsArray?.length) urlParams.set('participants', participantsArray.join(','));

        const resourcesArray = asParticipantArray(params.resources);
        if (resourcesArray?.length) urlParams.set('resources', resourcesArray.join(','));

        const endpoint = `/api/agents/tools/scheduling/availability?${urlParams}`;
        return await fetchApiToolGet(endpoint, 'Get available slots failed');
      }

      if (action === 'list') {
        const context_id = params.context_id || params.lead_id;
        return await fetchApiTool(
          '/api/agents/tools/scheduling/schedule',
          {
            action: 'list',
            site_id,
            context_id,
            status: params.status,
            date: params.date,
            timezone: params.timezone,
            limit: params.limit,
          },
          'List appointments failed'
        );
      }

      if (action === 'update') {
        const appointment_id = params.appointment_id || params.id;
        if (!appointment_id) {
          throw new Error('Missing required field for update: appointment_id');
        }

        return await fetchApiTool(
          '/api/agents/tools/scheduling/schedule',
          {
            action: 'update',
            site_id,
            appointment_id,
            title: params.title,
            start_datetime: params.start_datetime,
            duration: params.duration,
            timezone: params.timezone,
            status: params.status,
            location: params.location,
            description: params.description,
            reminder: params.reminder,
            participants: asParticipantArray(params.participants),
          },
          'Update appointment failed'
        );
      }

      if (action === 'schedule') {
        if (!params.title || !params.start_datetime || !params.duration || !params.timezone) {
          throw new Error(
            'Missing required fields for schedule: title, start_datetime, duration, timezone, context_id'
          );
        }
        const context_id = params.context_id || params.lead_id;
        if (!context_id) {
          throw new Error(
            'Missing required fields for schedule: title, start_datetime, duration, timezone, context_id'
          );
        }

        return await fetchApiTool(
          '/api/agents/tools/scheduling/schedule',
          {
            ...params,
            action: 'schedule',
            participants: asParticipantArray(params.participants),
            resources: asParticipantArray(params.resources),
            context_id,
            site_id: site_id,
          },
          'Schedule date failed'
        );
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
