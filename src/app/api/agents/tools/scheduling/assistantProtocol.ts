import { getApiBaseUrl } from '@/app/api/agents/tools/utils/fetch-helper';
import { buildSchedulingRecovery } from '@/lib/scheduling/recovery';
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
  calendar_id?: string;
  user_id?: string;
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

const SCHEDULING_TIMEOUT_MS = 5_500;
/** Preserve structured validation recovery without making security failures HTTP 200. */
export class SchedulingRequestRejected extends Error {
  constructor(message: string, readonly result?: Record<string, unknown>, readonly status = 422) {
    super(message);
    this.name = 'SchedulingRequestRejected';
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isSchedulingRecovery(value: unknown): value is ReturnType<typeof buildSchedulingRecovery> {
  if (!isRecord(value)) return false;
  const isDate = (date: unknown): date is string => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  return value.availability_confirmed === false
    && typeof value.current_time_utc === 'string' && Number.isFinite(Date.parse(value.current_time_utc))
    && typeof value.timezone === 'string' && Boolean(value.timezone)
    && isDate(value.local_date) && isDate(value.tomorrow) && value.tomorrow > value.local_date
    && typeof value.guidance === 'string'
    && Array.isArray(value.suggested_dates) && value.suggested_dates.length === 3
    && value.suggested_dates[0] === value.tomorrow
    && value.suggested_dates.every((date: unknown, index: number) => isDate(date)
      && date > (index === 0 ? value.local_date : value.suggested_dates[index - 1]))
    && !('slots' in value) && !('available_slots' in value);
}

/** Scheduling-only transport: retain recovery, bound the voice wait, never retry writes. */
async function fetchSchedulingTool(
  endpoint: string,
  args: SchedulingToolParams,
  body?: Record<string, unknown>,
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const failure = (code: string, data?: Record<string, any>) => {
    const recovery = isSchedulingRecovery(data?.recovery)
      ? data.recovery : buildSchedulingRecovery({ timezone: args.timezone, code });
    const writes = args.action === 'schedule' || args.action === 'update';
    return {
      success: false,
      // Structured endpoint recovery is a trusted, safe error contract. Never echo
      // arbitrary network errors, response HTML, URLs or upstream diagnostics.
      error: isSchedulingRecovery(data?.recovery) && typeof data?.error === 'string'
        ? data.error : 'Scheduling could not be confirmed. Follow the recovery guidance.',
      code,
      recovery: writes ? {
        ...recovery,
        availability_confirmed: false,
        auto_retry: false,
        write_state: 'unknown',
        guidance: `${recovery.guidance || ''} The schedule/update may already have completed. Do not claim success or retry the write automatically. Use scheduling action="list" for this caller and verify the appointment state before any retry.`,
      } : recovery,
    };
  };
  try {
    return await Promise.race([
      (async () => {
        const headers: Record<string, string> = {};
        if (body) headers['Content-Type'] = 'application/json';
        if (process.env.SERVICE_API_KEY) headers['x-api-key'] = process.env.SERVICE_API_KEY;
        const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
          method: body ? 'POST' : 'GET',
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
          cache: 'no-store',
        });
        if (response.status === 401 || response.status === 403) {
          throw new SchedulingRequestRejected('Scheduling authorization failed', undefined, response.status);
        }
        let data: unknown;
        try { data = JSON.parse(await response.text()); } catch (error) {
          if (controller.signal.aborted) throw error;
          return failure('SCHEDULING_MALFORMED_RESPONSE');
        }
        if (!isRecord(data)) return failure('SCHEDULING_MALFORMED_RESPONSE');
        const code = typeof data.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(data.code)
          ? data.code : 'SCHEDULING_EXECUTION_FAILED';
        if (/(?:^|_)(?:AUTH|UNAUTHORIZED|FORBIDDEN|IDENTITY|TENANT)(?:_|$)/.test(code)) {
          throw new SchedulingRequestRejected('Scheduling authorization failed', undefined, 403);
        }
        if (['INVALID_SCHEDULING_ARGUMENTS', 'INVALID_PARTICIPANTS', 'UNSUPPORTED_RESOURCES'].includes(code)) {
          const result = failure(code, data);
          throw new SchedulingRequestRejected(result.error, result);
        }
        if (!response.ok || data.success === false) {
          if ((response.status === 400 || response.status === 422) && !isRecord(data.recovery)) {
            const result = failure(code, data);
            throw new SchedulingRequestRejected('Scheduling input validation failed; verify the required fields', result, response.status);
          }
          return failure(code, data);
        }
        if (data.success !== true) return failure('SCHEDULING_MALFORMED_RESPONSE');
        return data;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Scheduling timeout'));
        }, SCHEDULING_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof SchedulingRequestRejected) throw error;
    return failure(controller.signal.aborted ? 'SCHEDULING_TIMEOUT' : 'SCHEDULING_NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

export function schedulingTool(site_id: string, _instance_id?: string) {
  return {
    name: 'scheduling',
    description:
      'First calendars action="list" for calendar_id (team) or user_id (person); never agent ID as team_id. For team/person appointments, not catalog inventory. Check availability with date, duration, timezone; copy verified slot start_utc and actual returned participant IDs to book. List caller appointments before schedule/update. On failure, recovery dates are NOT slots: confirm date then check; never book suggestions. Failed writes may have completed: list before retry. Voice: get_call_context is the live clock.',
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
        calendar_id: { type: 'string', description: 'Team calendar UUID from calendars action="list", not an agent ID. Omit target only when the server can select a unique enabled calendar.' },
        user_id: { type: 'string', description: 'Personal calendar profile UUID from calendars action="list". Unknown supplied targets never fall back to another calendar.' },
        team_id: { type: 'string', description: 'Legacy alias of calendar_id (team calendar UUID); never an agent ID.' },
        start_time: { type: 'string', description: 'Optional local query start bound; configured calendar hours are used when omitted.' },
        end_time: { type: 'string', description: 'Optional local query end bound; configured calendar hours are used when omitted.' },
        participants: {
          type: 'string',
          description: 'Actual profile IDs from the verified slot available_participants, comma-separated. Copy these IDs for booking; never calendar or agent IDs.',
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
        if (!params.date || !params.duration || !params.timezone) {
          throw new Error('Missing required fields for check_availability: date, duration, timezone');
        }

        const urlParams = new URLSearchParams({
          date: params.date,
          duration: String(params.duration),
          timezone: params.timezone,
          site_id: site_id,
        });
        if (params.calendar_id) urlParams.set('calendar_id', params.calendar_id);
        if (params.user_id) urlParams.set('user_id', params.user_id);
        if (params.team_id) urlParams.set('team_id', params.team_id);
        if (params.start_time) urlParams.set('start_time', params.start_time);
        if (params.end_time) urlParams.set('end_time', params.end_time);

        const participantsArray = asParticipantArray(params.participants);
        if (participantsArray?.length) urlParams.set('participants', participantsArray.join(','));

        const resourcesArray = asParticipantArray(params.resources);
        if (resourcesArray?.length) urlParams.set('resources', resourcesArray.join(','));

        const endpoint = `/api/agents/tools/scheduling/availability?${urlParams}`;
        return await fetchSchedulingTool(endpoint, args);
      }

      if (action === 'list') {
        const context_id = params.context_id || params.lead_id;
        return await fetchSchedulingTool(
          '/api/agents/tools/scheduling/schedule',
          args,
          {
            action: 'list',
            site_id,
            context_id,
            status: params.status,
            date: params.date,
            timezone: params.timezone,
            limit: params.limit,
          },
        );
      }

      if (action === 'update') {
        const appointment_id = params.appointment_id || params.id;
        if (!appointment_id) {
          throw new Error('Missing required field for update: appointment_id');
        }

        return await fetchSchedulingTool(
          '/api/agents/tools/scheduling/schedule',
          args,
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

        return await fetchSchedulingTool(
          '/api/agents/tools/scheduling/schedule',
          args,
          {
            ...params,
            action: 'schedule',
            participants: asParticipantArray(params.participants),
            resources: asParticipantArray(params.resources),
            context_id,
            site_id: site_id,
          },
        );
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
