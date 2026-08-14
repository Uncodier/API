import { DATE_PERIODS, DEFAULT_TIMEZONE, normalizeTimezone, type DatePeriod } from './constants';
import { formatClientLocalNow } from './format';
import { resolvePeriodBounds } from './periodBounds';

export function buildDateContextSection(timezone?: string | null, now: Date = new Date()): string {
  const tz = normalizeTimezone(timezone || DEFAULT_TIMEZONE);
  const bounds = DATE_PERIODS.map((period: DatePeriod) => {
    const range = resolvePeriodBounds(tz, period, now);
    return `- ${period}: gte ${range.start_utc}  lt ${range.end_utc}  (local ${range.local_start} .. ${range.local_end})`;
  }).join('\n');

  return `# Current Date & Time
Server UTC: ${now.toISOString()}
Client timezone: ${tz}
Client local now: ${formatClientLocalNow(now, tz)}
Precomputed UTC filter bounds (use these verbatim, or pass period / date_from / date_to on report and requirements):
${bounds}
Rule: User phrases like "hoy", "esta semana", "el mes pasado" mean CLIENT local time.
Never treat Server UTC calendar days as the client's day. Storage is UTC; speech is local.
Cron expressions on requirements fire in Server UTC — convert the client's local hour to UTC before writing cron.`;
}
