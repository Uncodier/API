import type { TimelineDayStatus } from '@/lib/status/get-system-timelines';

const STATUS_LABELS: Record<string, string> = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  skipped: 'Not configured',
  none: 'No data',
  operational: 'Operational',
  unknown: 'Unknown',
};

export function formatStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusCssClass(status: string): string {
  if (status === 'up' || status === 'operational') return 'up';
  if (status === 'degraded') return 'degraded';
  if (status === 'skipped') return 'skipped';
  if (status === 'none' || status === 'unknown') return 'none';
  return 'down';
}

export function formatUptimeDisplay(
  uptime: number | null | undefined,
  hasData: boolean,
): string {
  if (!hasData || uptime === null || uptime === undefined) return '—';
  return `${uptime}%`;
}

export function resolveCurrentStatus(
  systemStatus: string | undefined,
  lastDayStatus: TimelineDayStatus | undefined,
  hasProbeData: boolean,
): string {
  if (systemStatus && systemStatus !== 'none') return systemStatus;
  if (!hasProbeData) return 'none';
  return lastDayStatus ?? 'none';
}
