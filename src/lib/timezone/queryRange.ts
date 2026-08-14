import {
  type AppliedRange,
  type DatePeriod,
  isDatePeriod,
  isLocalDateString,
  normalizeTimezone,
} from './constants';
import {
  exclusiveEndToInclusiveIso,
  localDateBoundsToUtc,
  resolvePeriodBounds,
} from './periodBounds';

export interface DateRangeInput {
  period?: DatePeriod | string;
  date_from?: string;
  date_to?: string;
  now?: Date;
}

export function computeAppliedRange(
  timezone: string,
  input: DateRangeInput
): AppliedRange | null {
  const tz = normalizeTimezone(timezone);
  const { period, date_from, date_to, now } = input;

  if (isLocalDateString(date_from) || isLocalDateString(date_to)) {
    const from = isLocalDateString(date_from) ? date_from : date_to;
    const to = isLocalDateString(date_to) ? date_to : date_from;
    if (!from || !to) return null;
    const range = localDateBoundsToUtc(tz, from, to);
    return isDatePeriod(period) ? { ...range, period } : range;
  }

  if (isDatePeriod(period)) {
    return resolvePeriodBounds(tz, period, now);
  }

  return null;
}

export function coerceDateOnlyBound(
  value: string | undefined,
  timezone: string,
  bound: 'start' | 'endInclusive'
): string | undefined {
  if (!value) return undefined;
  if (!isLocalDateString(value)) return value;

  const range = localDateBoundsToUtc(timezone, value, value);
  if (bound === 'start') return range.start_utc;
  return exclusiveEndToInclusiveIso(range.end_utc);
}
