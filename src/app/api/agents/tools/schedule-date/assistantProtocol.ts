/**
 * Assistant Protocol Wrapper for Schedule Date Tool
 * Schedule appointments and calendar events
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface ScheduleDateToolParams {
  title: string;
  start_datetime: string;
  duration: number;
  timezone: string;
  context_id: string;
  participants?: string[];
  location?: string;
  description?: string;
  reminder?: number | string;
}

/**
 * Creates a schedule_date tool for OpenAI/assistant compatibility
 */
export function scheduleDateTool(site_id: string, instance_id?: string) {
  return {
    name: 'schedule_date',
    description:
      'Schedule an appointment or meeting. Required: title, start_datetime (ISO 8601), duration (minutes, min 5), timezone, context_id (lead_id or site_id). Optional: participants, location, description, reminder.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Appointment title' },
        start_datetime: { type: 'string', description: 'Start datetime ISO 8601' },
        duration: { type: 'number', description: 'Duration in minutes (min 5)' },
        timezone: { type: 'string', description: 'Timezone (e.g. America/New_York)' },
        context_id: { type: 'string', description: 'Context ID (lead_id, site_id, or similar)' },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: 'Participant IDs',
        },
        location: { type: 'string', description: 'Location' },
        description: { type: 'string', description: 'Description' },
        reminder: { type: 'number', description: 'Reminder minutes before' },
      },
      required: ['title', 'start_datetime', 'duration', 'timezone', 'context_id'],
    },
    execute: async (args: ScheduleDateToolParams) => {
      const body = {
        ...args,
        context_id: args.context_id || site_id,
      };
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/schedule-date`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Schedule date failed');
      }
      return data;
    },
  };
}
