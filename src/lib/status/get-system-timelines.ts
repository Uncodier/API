import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getHandlerSystemKeys } from '@/lib/status/handler-registry';
import { SYSTEM_LABELS } from '@/lib/status/system-labels';

export type TimelineDayStatus = 'up' | 'degraded' | 'down' | 'skipped' | 'none';

export interface TimelineDay {
  date: string;
  status: TimelineDayStatus;
  checkCount: number;
}

export interface SystemTimeline {
  systemKey: string;
  label: string;
  days: TimelineDay[];
  /** null when no probe checks exist in the window */
  uptimePercent: number | null;
}

const STATUS_PRIORITY: Record<TimelineDayStatus, number> = {
  none: 0,
  skipped: 1,
  up: 2,
  degraded: 3,
  down: 4,
};

export const TIMELINE_DAYS = 90;

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildDayRange(dayCount: number): string[] {
  const days: string[] = [];
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(utcDateKey(d));
  }
  return days;
}

export function aggregateDayStatus(statuses: string[]): TimelineDayStatus {
  if (statuses.length === 0) return 'none';
  let worst: TimelineDayStatus = 'none';
  let worstPriority = -1;
  for (const raw of statuses) {
    const s = (['up', 'degraded', 'down', 'skipped'].includes(raw) ? raw : 'none') as TimelineDayStatus;
    const p = STATUS_PRIORITY[s];
    if (p > worstPriority) {
      worstPriority = p;
      worst = s;
    }
  }
  return worst;
}

export function computeTimelineUptime(days: TimelineDay[]): number | null {
  const counted = days.filter((d) => d.status !== 'none' && d.status !== 'skipped');
  if (counted.length === 0) return null;
  const up = counted.filter((d) => d.status === 'up').length;
  return Math.round((up / counted.length) * 1000) / 10;
}

export function timelineHasProbeData(days: TimelineDay[]): boolean {
  return days.some((d) => d.checkCount > 0);
}

export function buildSystemTimeline(
  systemKey: string,
  dayRange: string[],
  rowsByDate: Map<string, string[]>,
): SystemTimeline {
  const days: TimelineDay[] = dayRange.map((date) => {
    const statuses = rowsByDate.get(date) ?? [];
    return {
      date,
      status: aggregateDayStatus(statuses),
      checkCount: statuses.length,
    };
  });
  return {
    systemKey,
    label: SYSTEM_LABELS[systemKey] ?? systemKey,
    days,
    uptimePercent: computeTimelineUptime(days),
  };
}

export async function getSystemTimelines(dayCount = TIMELINE_DAYS): Promise<SystemTimeline[]> {
  const dayRange = buildDayRange(dayCount);
  const since = `${dayRange[0]}T00:00:00.000Z`;

  const { data: rows, error } = await supabaseAdmin
    .from('system_status')
    .select('system_key, status, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  const bySystem = new Map<string, Map<string, string[]>>();
  if (!error && rows) {
    for (const row of rows) {
      const dateKey = utcDateKey(new Date(row.created_at));
      if (!dayRange.includes(dateKey)) continue;
      let systemMap = bySystem.get(row.system_key);
      if (!systemMap) {
        systemMap = new Map();
        bySystem.set(row.system_key, systemMap);
      }
      const list = systemMap.get(dateKey) ?? [];
      list.push(row.status);
      systemMap.set(dateKey, list);
    }
  }

  const allKeys = getHandlerSystemKeys();
  return allKeys.map((systemKey) => {
    const rowsByDate = bySystem.get(systemKey) ?? new Map();
    return buildSystemTimeline(systemKey, dayRange, rowsByDate);
  });
}
