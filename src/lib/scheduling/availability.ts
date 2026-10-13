import { z } from 'zod';
import { formatInTimezone, isValidIanaTimezone, localDateBoundsToUtc, localWallTimeToUtc, localYmd } from '@/lib/timezone';
import { normalizeTime, type WeeklyAvailability, type Weekday } from '@/lib/reservations/weekly-hours';
import { generateAvailableSlots, type SchedulingWindow } from './availability-slots';
import { loadSchedulingDirectory, resolveCalendarMembers, schedulingDatabase, SchedulingAvailabilityError, type SchedulingMember, type TeamCalendar } from './calendar-directory';

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const inputSchema = z.object({
  site_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }),
  duration: z.number().int().min(15).max(1440),
  timezone: z.string().refine(isValidIanaTimezone),
  calendar_id: z.string().uuid().optional(),
  team_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  start_time: clock.optional(),
  end_time: clock.optional(),
  participants: z.array(z.string().uuid()).default([]),
  resources: z.array(z.string()).default([]),
}).refine(value => !value.start_time || !value.end_time || value.start_time < value.end_time)
  .refine(value => !value.calendar_id || !value.team_id || value.calendar_id === value.team_id)
  .refine(value => !value.user_id || !(value.calendar_id || value.team_id));

type Hours = { days: WeeklyAvailability; timezone: string };

function configuredWallTime(ymd: string, timezone: string, clock: string): number {
  const instant = localWallTimeToUtc(ymd, timezone, `${clock}:00`);
  // date-fns-tz normalizes nonexistent spring-forward times backwards. Never
  // expand availability outside the configured wall-clock window this way.
  if (formatInTimezone(instant, timezone, 'yyyy-MM-dd HH:mm') !== `${ymd} ${clock}`) {
    throw new Error('Nonexistent configured wall time');
  }
  return instant.getTime();
}

function businessHours(raw: unknown, timezone: string): Hours[] {
  if (!raw) return [];
  const entries = Array.isArray(raw) ? raw : [raw];
  return entries.filter(entry => entry && typeof entry === 'object' && entry.enabled !== false)
    .map(entry => ({ days: entry.days || entry, timezone: entry.timezone || timezone }));
}

function intersect(a: SchedulingWindow[], b: SchedulingWindow[]): SchedulingWindow[] {
  return a.flatMap(left => b.map(right => ({ start: Math.max(left.start, right.start), end: Math.min(left.end, right.end) })))
    .filter(window => window.end > window.start);
}

/** Convert configured hours in their own timezone, including lunch and cross-zone day changes. */
function hoursWindows(hours: Hours, start: number, end: number): SchedulingWindow[] {
  if (!isValidIanaTimezone(hours.timezone) || !hours.days || typeof hours.days !== 'object') {
    throw new SchedulingAvailabilityError('CALENDAR_NOT_CONFIGURED', 'La zona horaria o los horarios del calendario no son válidos');
  }
  const firstDay = localYmd(new Date(start), hours.timezone);
  const windows: SchedulingWindow[] = [];
  // A local query day can touch two calendar days (three around extreme timezone offsets).
  for (let offset = 0; offset < 3; offset++) {
    const day = new Date(`${firstDay}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offset);
    const ymd = day.toISOString().slice(0, 10);
    if (localWallTimeToUtc(ymd, hours.timezone).getTime() >= end) break;
    const key = formatInTimezone(localWallTimeToUtc(ymd, hours.timezone, '12:00:00'), hours.timezone, 'EEEE').toLowerCase() as Weekday;
    const config = hours.days[key];
    if (!config || config.enabled === false) continue;
    if (!config.start || !config.end) {
      throw new SchedulingAvailabilityError('CALENDAR_NOT_CONFIGURED', 'Faltan horarios de apertura o cierre del calendario');
    }
    try {
      const clockStart = normalizeTime(config.start);
      const clockEnd = normalizeTime(config.end);
      if (clockEnd <= clockStart) throw new Error('Invalid window');
      let segments = [{
        start: configuredWallTime(ymd, hours.timezone, clockStart),
        end: configuredWallTime(ymd, hours.timezone, clockEnd),
      }];
      for (const pause of config.breaks || []) {
        const from = normalizeTime(pause.start), to = normalizeTime(pause.end);
        if (to <= from || from < clockStart || to > clockEnd) throw new Error('Invalid break');
        const breakStart = configuredWallTime(ymd, hours.timezone, from);
        const breakEnd = configuredWallTime(ymd, hours.timezone, to);
        segments = segments.flatMap(segment => [
          { start: segment.start, end: Math.min(segment.end, breakStart) },
          { start: Math.max(segment.start, breakEnd), end: segment.end },
        ]).filter(segment => segment.end > segment.start);
      }
      windows.push(...intersect(segments, [{ start, end }]));
    } catch {
      throw new SchedulingAvailabilityError('CALENDAR_NOT_CONFIGURED', 'Los horarios o descansos del calendario no son válidos');
    }
  }
  return windows;
}

function memberWindows(member: SchedulingMember, companyHours: Hours[], timezone: string, start: number, end: number) {
  if (member.calendar?.enabled === false) return [];
  const personal = member.calendar?.availability;
  if (!personal && !companyHours.length) {
    throw new SchedulingAvailabilityError('CALENDAR_NOT_CONFIGURED', 'No hay horarios configurados para el calendario');
  }
  const company = companyHours.flatMap(hours => hoursWindows(hours, start, end));
  const own = personal ? hoursWindows({ days: personal, timezone: member.calendar?.timezone || timezone }, start, end) : company;
  return personal && companyHours.length ? intersect(own, company) : own;
}

export async function getSchedulingAvailability(raw: unknown, now = new Date()) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SchedulingAvailabilityError('INVALID_SCHEDULING_ARGUMENTS', 'Usa fecha YYYY-MM-DD, zona IANA, duración de al menos 15 minutos e identificadores de calendarios válidos', 400);
  }
  const input = parsed.data;
  const timezone = input.timezone;
  if (input.date < localYmd(now, timezone)) {
    throw new SchedulingAvailabilityError('DATE_IN_PAST', 'No se pueden consultar fechas en el pasado');
  }
  if (input.resources.length) {
    throw new SchedulingAvailabilityError('UNSUPPORTED_RESOURCES', 'Para reservar recursos o servicios usa la herramienta reservations');
  }
  const directory = await loadSchedulingDirectory(input.site_id);
  let calendar: TeamCalendar | undefined;
  let members: SchedulingMember[];
  const calendarId = input.calendar_id || input.team_id;
  if (calendarId) {
    calendar = directory.calendars.find(candidate => candidate.id === calendarId && candidate.enabled !== false);
    if (!calendar) throw new SchedulingAvailabilityError('CALENDAR_NOT_FOUND', 'Calendario no encontrado en este sitio; consulta calendars.list', 404);
    members = resolveCalendarMembers(calendar, directory.members);
  } else if (input.user_id) {
    members = directory.members.filter(member => member.id === input.user_id && member.calendar?.enabled === true);
    if (!members.length) throw new SchedulingAvailabilityError('CALENDAR_NOT_FOUND', 'Calendario personal no disponible en este sitio', 404);
  } else {
    const enabled = directory.calendars.filter(candidate => candidate.enabled !== false);
    const personal = directory.members.filter(member => member.calendar?.enabled === true);
    if (enabled.length === 1) {
      calendar = enabled[0];
      members = resolveCalendarMembers(calendar, directory.members);
    } else if (!enabled.length && personal.length === 1) {
      members = personal;
    } else {
      throw new SchedulingAvailabilityError('CALENDAR_SELECTION_REQUIRED', 'Consulta calendars.list y confirma qué calendario o persona debe atender la cita');
    }
  }
  if (input.participants.some(id => !members.some(member => member.id === id))) {
    throw new SchedulingAvailabilityError('INVALID_PARTICIPANTS', 'Los participantes deben pertenecer al calendario seleccionado', 400);
  }
  if (input.participants.length) members = members.filter(member => input.participants.includes(member.id));
  const calendarTimezone = calendar?.timezone || directory.timezone;
  const range = localDateBoundsToUtc(timezone, input.date);
  const start = Date.parse(range.start_utc), end = Date.parse(range.end_utc);
  const hours = businessHours(directory.businessHours, calendarTimezone);
  const windows = new Map(members.map(member => [member.id, memberWindows(member, hours, calendarTimezone, start, end)]));
  const buffer = calendar?.buffer ?? 0;
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 1440) {
    throw new SchedulingAvailabilityError('CALENDAR_NOT_CONFIGURED', 'El tiempo de separación del calendario no es válido');
  }
  const db = schedulingDatabase();
  const [appointments, blocks] = await Promise.all([
    db.from('appointments').select('id, start_datetime, end_datetime, participants')
      .eq('site_id', input.site_id).eq('status', 'confirmed')
      .lt('start_datetime', new Date(end + buffer * 60_000).toISOString())
      .gt('end_datetime', new Date(start - buffer * 60_000).toISOString()),
    db.from('calendar_blocks').select('entity_type, entity_id, start_time, end_time')
      .eq('site_id', input.site_id).in('entity_type', ['global', 'user'])
      .lt('start_time', range.end_utc).gt('end_time', range.start_utc),
  ]);
  if (appointments.error || blocks.error) {
    throw new SchedulingAvailabilityError('AVAILABILITY_UNAVAILABLE', 'No se pudo verificar la disponibilidad. Intenta de nuevo', 503);
  }
  const publicMembers = members.map(({ id, name, role }) => ({ id, name, role }));
  // Keep internal email aliases for legacy conflicts, never expose them in the response.
  const slots = generateAvailableSlots(input.date, input.start_time || '00:00', input.end_time || '23:59', input.duration,
    appointments.data || [], input.participants, [], members, timezone,
    { now, memberWindows: windows, bufferMinutes: buffer, blocks: blocks.data || [] });
  return {
    success: true, date: input.date, timezone, availability_confirmed: true,
    calendar_id: calendar?.id, user_id: calendar ? undefined : members[0]?.id,
    available_slots: slots.map(slot => ({ ...slot,
      available_participants: slot.available_participants.map(({ id, name, role }) => ({ id, name, role })),
    })),
    team_members: publicMembers,
    unavailable_participants: input.participants.filter(id => !slots.some(slot => slot.available_participants.some(member => member.id === id))),
    unavailable_resources: [],
    guidance: 'These slots were checked, not booked. For a team calendar select one returned available participant; if specific participants were requested copy those IDs. List this caller\'s appointments before scheduling; copy start_utc unchanged.',
  };
}