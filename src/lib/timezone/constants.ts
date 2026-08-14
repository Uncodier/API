export const DEFAULT_TIMEZONE = 'America/Mexico_City';

export const DATE_PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
] as const;

export type DatePeriod = (typeof DATE_PERIODS)[number];

export const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AppliedRange {
  timezone: string;
  start_utc: string;
  end_utc: string;
  local_start: string;
  local_end: string;
  period?: DatePeriod;
}

export function isDatePeriod(value: unknown): value is DatePeriod {
  return typeof value === 'string' && (DATE_PERIODS as readonly string[]).includes(value);
}

export function isLocalDateString(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_DATE_RE.test(value);
}

export function isValidIanaTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimezone(timezone?: string | null): string {
  if (timezone && isValidIanaTimezone(timezone.trim())) {
    return timezone.trim();
  }
  return DEFAULT_TIMEZONE;
}
