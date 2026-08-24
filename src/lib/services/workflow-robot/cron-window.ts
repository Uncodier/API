import { CronExpressionParser } from 'cron-parser';

export const WORKFLOW_CRON_WINDOW_MS = 120_000;

export function isCronDueInWindow(
  cron: string,
  nowMs: number = Date.now(),
  windowMs: number = WORKFLOW_CRON_WINDOW_MS,
): boolean {
  const interval = CronExpressionParser.parse(cron);
  const prev = interval.prev().toDate();
  return nowMs - prev.getTime() < windowMs;
}
