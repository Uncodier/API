import { formatInTimeZone } from 'date-fns-tz';
import { normalizeTimezone } from './constants';

export function formatInTimezone(
  isoUtc: string | Date | number,
  timezone: string,
  pattern = 'yyyy-MM-dd HH:mm'
): string {
  const date = isoUtc instanceof Date ? isoUtc : new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return '';
  return formatInTimeZone(date, normalizeTimezone(timezone), pattern);
}

export function formatClientLocalNow(now: Date, timezone: string): string {
  return formatInTimezone(now, timezone, "EEEE, d MMM yyyy, HH:mm");
}
