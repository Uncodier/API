import { parseISO } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import {
  DEFAULT_TIMEZONE,
  type AppliedRange,
  type DatePeriod,
  isLocalDateString,
  normalizeTimezone,
} from './constants';

const TZ_OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

function addDaysYmd(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}

function mondayOf(ymd: string): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = utc.getUTCDay();
  const offset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return addDaysYmd(ymd, -offset);
}

function startOfMonthYmd(ymd: string): string {
  return `${ymd.slice(0, 8)}01`;
}

export function localWallTimeToUtc(ymd: string, timezone: string, time = '00:00:00'): Date {
  return fromZonedTime(`${ymd}T${time}`, normalizeTimezone(timezone));
}

/**
 * Offset/Z strings are UTC instants. Naive date-times are wall-clock in `timezone`
 * (12:00 America/Mexico_City → 18:00Z, not 12:00Z).
 */
export function parseInstantOrWallClock(value: string, timezone: string): Date {
  const trimmed = String(value || '').trim();
  if (!trimmed) return new Date(NaN);

  if (TZ_OFFSET_RE.test(trimmed)) {
    return parseISO(trimmed);
  }

  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?)/);
  if (!match) return parseISO(trimmed);

  const [, ymd, clock] = match;
  const [hours = '00', minutes = '00', seconds = '00'] = clock.split(':');
  return localWallTimeToUtc(
    ymd,
    timezone,
    `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}`
  );
}

export function localDateBoundsToUtc(
  timezone: string,
  fromYmd: string,
  toYmd: string = fromYmd
): AppliedRange {
  const tz = normalizeTimezone(timezone);
  if (!isLocalDateString(fromYmd) || !isLocalDateString(toYmd)) {
    throw new Error('date_from and date_to must be YYYY-MM-DD local calendar dates');
  }

  const start = fromYmd <= toYmd ? fromYmd : toYmd;
  const endInclusive = fromYmd <= toYmd ? toYmd : fromYmd;
  const startUtc = localWallTimeToUtc(start, tz);
  const endUtc = localWallTimeToUtc(addDaysYmd(endInclusive, 1), tz);

  return {
    timezone: tz,
    start_utc: startUtc.toISOString(),
    end_utc: endUtc.toISOString(),
    local_start: start,
    local_end: endInclusive,
  };
}

export function localYmd(now: Date, timezone: string): string {
  return formatInTimeZone(now, normalizeTimezone(timezone), 'yyyy-MM-dd');
}

export function resolvePeriodBounds(
  timezone: string,
  period: DatePeriod,
  now: Date = new Date()
): AppliedRange {
  const tz = normalizeTimezone(timezone);
  const today = localYmd(now, tz);

  let localStart = today;
  let localEnd = today;

  switch (period) {
    case 'today':
      break;
    case 'yesterday':
      localStart = addDaysYmd(today, -1);
      localEnd = localStart;
      break;
    case 'this_week':
      localStart = mondayOf(today);
      localEnd = addDaysYmd(localStart, 6);
      break;
    case 'last_week': {
      const thisMonday = mondayOf(today);
      localStart = addDaysYmd(thisMonday, -7);
      localEnd = addDaysYmd(localStart, 6);
      break;
    }
    case 'this_month':
      localStart = startOfMonthYmd(today);
      localEnd = addDaysYmd(startOfMonthYmd(addDaysYmd(localStart, 32)), -1);
      break;
    case 'last_month': {
      const firstThisMonth = startOfMonthYmd(today);
      localEnd = addDaysYmd(firstThisMonth, -1);
      localStart = startOfMonthYmd(localEnd);
      break;
    }
  }

  return {
    ...localDateBoundsToUtc(tz, localStart, localEnd),
    period,
  };
}

export function exclusiveEndToInclusiveIso(endUtc: string): string {
  return new Date(new Date(endUtc).getTime() - 1).toISOString();
}

export { DEFAULT_TIMEZONE };
