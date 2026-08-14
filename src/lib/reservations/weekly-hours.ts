export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export type DayBreak = {
  start: string;
  end: string;
};

export type DayAvailability = {
  enabled: boolean;
  start?: string;
  end?: string;
  breaks?: DayBreak[];
};

export type WeeklyAvailability = Partial<Record<Weekday, DayAvailability>>;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseDaysInput(days: unknown): WeeklyAvailability {
  if (!days) {
    throw new Error('Missing availability/days. Pass a weekly object with lowercase english day keys.');
  }
  if (typeof days === 'string') {
    try {
      return JSON.parse(days);
    } catch {
      throw new Error('availability/days must be a JSON object or a JSON-encoded string.');
    }
  }
  if (typeof days !== 'object' || Array.isArray(days)) {
    throw new Error('availability/days must be an object keyed by weekday.');
  }
  return days as WeeklyAvailability;
}

export function normalizeTime(raw: string, field = 'time'): string {
  const value = String(raw || '').trim();
  if (TIME_RE.test(value)) return value;

  const match = value.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) {
    throw new Error(`Invalid ${field} "${raw}". Use 24h HH:mm (e.g. 11:00, 20:00 for 8pm).`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2] || '0');
  if (hours > 23 || minutes > 59) {
    throw new Error(`Invalid ${field} "${raw}". Hours 0-23, minutes 0-59.`);
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function toMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

function normalizeBreaks(breaks: unknown, dayStart: string, dayEnd: string): DayBreak[] {
  if (breaks === undefined || breaks === null) return [];
  if (!Array.isArray(breaks)) {
    throw new Error('breaks must be an array of { start, end } (e.g. lunch 15:00-16:00).');
  }

  return breaks.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`breaks[${index}] must be an object with start and end.`);
    }
    const start = normalizeTime((item as DayBreak).start, `breaks[${index}].start`);
    const end = normalizeTime((item as DayBreak).end, `breaks[${index}].end`);
    if (toMinutes(end) <= toMinutes(start)) {
      throw new Error(`breaks[${index}] end must be after start.`);
    }
    if (toMinutes(start) < toMinutes(dayStart) || toMinutes(end) > toMinutes(dayEnd)) {
      throw new Error(`breaks[${index}] must fall inside the working window ${dayStart}-${dayEnd}.`);
    }
    return { start, end };
  });
}

export function normalizeWeeklyAvailability(input: unknown): WeeklyAvailability {
  const days = parseDaysInput(input);
  const invalidKeys = Object.keys(days).filter((key) => !WEEKDAYS.includes(key as Weekday));
  if (invalidKeys.length > 0) {
    throw new Error(
      `Invalid weekday keys: ${invalidKeys.join(', ')}. Use lowercase english days: ${WEEKDAYS.join(', ')}.`
    );
  }

  const normalized: WeeklyAvailability = {};
  for (const day of WEEKDAYS) {
    const config = days[day];
    if (!config) {
      normalized[day] = { enabled: false };
      continue;
    }

    const enabled = Boolean(config.enabled);
    if (!enabled) {
      normalized[day] = { enabled: false };
      continue;
    }

    if (!config.start || !config.end) {
      throw new Error(`${day} is enabled but missing start/end (24h HH:mm).`);
    }

    const start = normalizeTime(config.start, `${day}.start`);
    const end = normalizeTime(config.end, `${day}.end`);
    if (toMinutes(end) <= toMinutes(start)) {
      throw new Error(`${day} end must be after start. Use 20:00 for 8pm.`);
    }

    normalized[day] = {
      enabled: true,
      start,
      end,
      breaks: normalizeBreaks(config.breaks, start, end),
    };
  }

  const hasEnabledDay = WEEKDAYS.some((day) => normalized[day]?.enabled);
  if (!hasEnabledDay) {
    throw new Error('Schedule must have at least one enabled day.');
  }

  return normalized;
}

export function slotOverlapsBreaks(
  slotStartMin: number,
  slotEndMin: number,
  breaks?: DayBreak[] | null
): boolean {
  if (!Array.isArray(breaks) || breaks.length === 0) return false;
  return breaks.some((item) => {
    const breakStart = toMinutes(item.start);
    const breakEnd = toMinutes(item.end);
    return slotStartMin < breakEnd && slotEndMin > breakStart;
  });
}
