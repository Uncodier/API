/**
 * Assistant Protocol Wrapper for Scheduling Tool
 * Unified tool for scheduling (check_availability, schedule)
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface SchedulingToolParams {
  action: 'check_availability' | 'schedule';

  // check_availability params
  date?: string;
  duration?: number;
  timezone?: string;
  team_id?: string;
  start_time?: string;
  end_time?: string;
  participants?: string[];
  resources?: string[];

  // schedule params
  title?: string;
  start_datetime?: string;
  context_id?: string;
  location?: string;
  description?: string;
  reminder?: number | string;
}

export function schedulingTool(site_id: string, instance_id?: string) {
  return {
    name: 'scheduling',
    description:
      'Manage scheduling. Use action="check_availability" to get available slots (requires date, duration, timezone, team_id). Use action="schedule" to schedule an appointment (requires title, start_datetime, duration, timezone, context_id).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check_availability', 'schedule'],
          description: 'Action to perform: check_availability or schedule.',
        },
        // check_availability params
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        duration: { type: 'number', description: 'Meeting duration in minutes (min 15 for check, min 5 for schedule)' },
        timezone: { type: 'string', description: 'Timezone (e.g. America/New_York)' },
        team_id: { type: 'string', description: 'Team UUID (required for check_availability)' },
        start_time: { type: 'string', description: 'Day start time (default 09:00)' },
        end_time: { type: 'string', description: 'Day end time (default 17:00)' },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: 'Participant IDs to check availability',
        },
        resources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Resource IDs',
        },
        // schedule params
        title: { type: 'string', description: 'Appointment title' },
        start_datetime: { type: 'string', description: 'Start datetime ISO 8601' },
        context_id: { type: 'string', description: 'Context ID (lead_id, site_id, or similar)' },
        location: { type: 'string', description: 'Location' },
        description: { type: 'string', description: 'Description' },
        reminder: { type: 'number', description: 'Reminder minutes before' },
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
        if (params.participants?.length) urlParams.set('participants', params.participants.join(','));
        if (params.resources?.length) urlParams.set('resources', params.resources.join(','));

        const res = await fetch(
          `${getApiBaseUrl()}/api/agents/tools/scheduling/availability?${urlParams}`
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Get available slots failed');
        }
        return data;
      }

      if (action === 'schedule') {
        if (!params.title || !params.start_datetime || !params.duration || !params.timezone || !params.context_id) {
          throw new Error(
            'Missing required fields for schedule: title, start_datetime, duration, timezone, context_id'
          );
        }

        const body = {
          ...params,
          context_id: params.context_id || site_id,
          site_id: site_id,
        };

        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/scheduling/schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Schedule date failed');
        }
        return data;
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
