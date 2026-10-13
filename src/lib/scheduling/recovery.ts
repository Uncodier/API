import { normalizeTimezone } from '@/lib/timezone/constants';

/** Calendar arithmetic, not 24-hour instant arithmetic (which breaks at DST). */
function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Pure shared clock snapshot. Never derive "today" from persisted call history. */
export function buildSchedulingDateContext(timezone?: string, now: Date = new Date()) {
  const tz = normalizeTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  const localDate = `${part('year')}-${part('month')}-${part('day')}`;
  return {
    current_time_utc: now.toISOString(),
    local_date: localDate,
    tomorrow: addCalendarDays(localDate, 1),
    timezone: tz,
  };
}

/** Date suggestions are conversation prompts only, never availability or slots. */
export function buildSchedulingRecovery({ timezone, now, code }: {
  timezone?: string;
  now?: Date;
  code?: string;
} = {}) {
  const context = buildSchedulingDateContext(timezone, now);
  return {
    ...context,
    ...(code ? { code } : {}),
    suggested_dates: [1, 2, 3].map(days => addCalendarDays(context.local_date, days)),
    availability_confirmed: false as const,
    auto_retry: false as const,
    guidance: 'Use these authoritative local dates, not historical dates. Confirm a date with the caller, then retry check_availability for that date. First use calendars action="list" for calendar_id or user_id; never use an agent ID as team_id. Suggested dates are NOT available slots: never book or claim availability from suggestions. Only book a verified slot, copying its start_utc and actual returned participant IDs. Never automatically retry side-effect operations. If schedule/update failed, the write state may be unknown: list current appointments before considering a retry.',
  };
}