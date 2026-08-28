import { CronExpressionParser } from 'cron-parser';
import { DEFAULT_TIMEZONE, normalizeTimezone } from '@/lib/timezone';

export const WORKFLOW_CRON_WINDOW_MS = 120_000;

export function isCronDueInWindow(
  cron: string,
  nowMs: number = Date.now(),
  windowMs: number = WORKFLOW_CRON_WINDOW_MS,
  tz: string = DEFAULT_TIMEZONE,
): boolean {
  const interval = CronExpressionParser.parse(cron, {
    currentDate: nowMs,
    tz: normalizeTimezone(tz),
  });
  const prev = interval.prev().toDate();
  const delta = nowMs - prev.getTime();
  return delta >= 0 && delta < windowMs;
}
