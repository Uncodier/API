import {
  getLatestDailyStandupSettings, normalizeReportSections, persistedReportSections,
} from './dailyStandupReportSections';

/** Rechecked on every delivery attempt; never trust a workflow's stale selection. */
export async function isDailyStandupNotificationAllowed(siteId: string, requested: unknown, now = new Date()) {
  const settings = await getLatestDailyStandupSettings(siteId);
  const persisted = persistedReportSections(settings?.activities);
  const selected = normalizeReportSections(requested);
  if (!selected.length || selected.some(section => !persisted.includes(section))) return false;
  // Legacy unscoped messages can contain every section. Only accept them when all remain enabled.
  if (selected.length !== persisted.length) return false;
  // All deliveries, including legacy queued workflows, obey current activation and local days.
  const activity = settings?.activities?.daily_resume_and_stand_up;
  const status = typeof activity === 'string' ? activity : activity?.status;
  if (status !== 'active') return false;
  const weekdays = activity?.weekdays === undefined ? [1, 5] : activity.weekdays;
  if (!Array.isArray(weekdays) || !weekdays.length ||
      weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return false;
  const hours = Array.isArray(settings?.business_hours) ? settings.business_hours[0] : settings?.business_hours;
  const timezone = hours?.timezone ?? 'America/Mexico_City';
  try {
    if (typeof timezone !== 'string' || !timezone.trim()) return false;
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone }).format(now);
    if (!weekdays.includes(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day))) return false;
  } catch { return false; }
  return true;
}