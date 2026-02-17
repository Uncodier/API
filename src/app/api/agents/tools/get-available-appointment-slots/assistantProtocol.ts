/**
 * Assistant Protocol Wrapper for Get Available Appointment Slots Tool
 * Get available time slots for scheduling
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface GetAvailableAppointmentSlotsToolParams {
  date: string;
  duration: number;
  timezone: string;
  team_id: string;
  start_time?: string;
  end_time?: string;
  participants?: string[];
  resources?: string[];
}

/**
 * Creates a get_available_appointment_slots tool for OpenAI/assistant compatibility
 */
export function getAvailableAppointmentSlotsTool(site_id?: string) {
  return {
    name: 'get_available_appointment_slots',
    description:
      'Get available appointment slots for a date. Required: date (YYYY-MM-DD), duration (minutes, min 15), timezone, team_id. Optional: start_time, end_time, participants, resources.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        duration: { type: 'number', description: 'Meeting duration in minutes (min 15)' },
        timezone: { type: 'string', description: 'Timezone (e.g. America/New_York)' },
        team_id: { type: 'string', description: 'Team UUID' },
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
      },
      required: ['date', 'duration', 'timezone', 'team_id'],
    },
    execute: async (args: GetAvailableAppointmentSlotsToolParams) => {
      const params = new URLSearchParams({
        date: args.date,
        duration: String(args.duration),
        timezone: args.timezone,
        team_id: args.team_id,
      });
      if (args.start_time) params.set('start_time', args.start_time);
      if (args.end_time) params.set('end_time', args.end_time);
      if (args.participants?.length) params.set('participants', args.participants.join(','));
      if (args.resources?.length) params.set('resources', args.resources.join(','));
      const res = await fetch(
        `${getApiBaseUrl()}/api/agents/tools/get-available-appointment-slots?${params}`
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Get available slots failed');
      }
      return data;
    },
  };
}
