import type { OutreachActivityKey } from './policy';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const validStartTime = (value: unknown): value is string => typeof value === 'string'
  && value.length === 5 && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** Keep this contract aligned with Workflows/utils/activityStartTime.ts. */
export function validOutreachTiming(raw: any): boolean {
  if (raw?.start_time_mode === 'business_opening') return true;
  if (raw?.start_time_mode !== undefined && raw.start_time_mode !== 'custom') return false;
  return (raw?.start_time_mode !== 'custom' && raw?.start_time === undefined) || validStartTime(raw?.start_time);
}

/** Returns a deferral reason; absent timing fields preserve historical runtime behavior. */
export function outreachTimingReason(settings: any, activity: OutreachActivityKey, now = new Date()): string | undefined {
  const raw = settings?.activities?.[activity];
  if (!validOutreachTiming(raw)) return 'invalid_outreach_configuration';
  const hours = Array.isArray(settings?.business_hours) ? settings.business_hours[0] : settings?.business_hours;
  const timezone = hours?.timezone ?? 'America/Mexico_City';
  try {
    if (typeof timezone !== 'string' || !timezone.trim()) return 'invalid_timezone';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const get = (key: string) => parts.find(part => part.type === key)!.value;
    const weekday = WEEKDAYS.indexOf(get('weekday').toLowerCase());
    const mode = raw?.start_time_mode ?? (raw?.start_time === undefined ? (activity === 'invoices_due' ? 'business_opening' : undefined) : 'custom');
    if (mode === undefined) return undefined;
    const day = hours?.days?.[WEEKDAYS[weekday]] ?? hours?.[WEEKDAYS[weekday]];
    if (activity === 'leads_initial_cold_outreach'
      && (day?.enabled === false || (!day && (weekday === 0 || weekday === 6)))) return 'business_closed';
    if (mode === 'business_opening' && day?.enabled === false) return 'business_closed';
    const opening = day?.start ?? day?.open;
    const time = mode === 'custom' ? raw.start_time : validStartTime(opening) ? opening : '09:00';
    return `${get('hour')}:${get('minute')}` < time ? 'before_start_time' : undefined;
  } catch { return 'invalid_timezone'; }
}