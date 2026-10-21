import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getHandlerSystemKeys } from '@/lib/status/handler-registry';
import { getDailyStatusCounts } from '@/lib/status/history-aggregates';
import { normalizeHealthStatus } from '@/lib/status/observation';
import { SYSTEM_LABELS } from '@/lib/status/system-labels';

export type TimelineDayStatus = 'up' | 'degraded' | 'down' | 'skipped' | 'none';

export interface TimelineDay {
  date: string;
  status: TimelineDayStatus;
  checkCount: number;
  /** Checks with observed health, excluding skipped/unverified checks. */
  observedCheckCount?: number;
  /** Successful observed checks, even when another check made the day non-green. */
  upCheckCount?: number;
}

export interface SystemTimeline {
  systemKey: string;
  label: string;
  days: TimelineDay[];
  /** Percentage of successful observed checks; null when no observed checks exist. */
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
const HISTORY_PAGE_SIZE = 500;

export interface StatusHistoryRow {
  id: string;
  system_key: string;
  status: string;
  created_at: string;
  health_payload: { checks?: Record<string, unknown> | null } | null;
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildDayRange(dayCount: number, now: Date): string[] {
  const days: string[] = [];
  const end = new Date(now);
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
  let observed = 0;
  let up = 0;
  for (const day of days) {
    if (day.status === 'none' || day.status === 'skipped') continue;
    // Older callers do not have per-status counts; retain their day status,
    // weighted by checkCount rather than counting each day equally.
    const dayObserved = day.observedCheckCount ?? day.checkCount;
    observed += dayObserved;
    up += day.upCheckCount ?? (day.status === 'up' ? dayObserved : 0);
  }
  if (observed === 0) return null;
  return Math.round((up / observed) * 1000) / 10;
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
      observedCheckCount: statuses.filter((status) => ['up', 'degraded', 'down'].includes(status)).length,
      upCheckCount: statuses.filter((status) => status === 'up').length,
    };
  });
  return {
    systemKey,
    label: SYSTEM_LABELS[systemKey] ?? systemKey,
    days,
    uptimePercent: computeTimelineUptime(days),
  };
}

/** Exhaust a bounded history window, including when the server caps each page. */
export async function loadStatusHistory(since: string, until: string): Promise<StatusHistoryRow[]> {
  const history: StatusHistoryRow[] = [];
  let offset = 0;
  while (true) {
    const { data: rows, error } = await supabaseAdmin
      .from('system_status')
      .select('id, system_key, status, created_at, health_payload')
      .gte('created_at', since)
      .lte('created_at', until)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + HISTORY_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to load system status history: ${error.message}`, { cause: error });
    }
    if (!rows) {
      throw new Error('System status history query returned no data');
    }
    if (rows.length === 0) break;
    history.push(...rows);
    // A short page can be the server's row cap, not the end of history.
    offset += rows.length;
  }
  return history;
}

export async function getSystemTimelines(dayCount = TIMELINE_DAYS): Promise<SystemTimeline[]> {
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > TIMELINE_DAYS) {
    throw new RangeError(`dayCount must be an integer between 1 and ${TIMELINE_DAYS}`);
  }
  const now = new Date();
  const dayRange = buildDayRange(dayCount, now);
  const since = `${dayRange[0]}T00:00:00.000Z`;
  const until = now.toISOString();
  const dailyCounts = await getDailyStatusCounts(since, until);
  if (dailyCounts !== null) {
    const bySystem = new Map<string, Map<string, TimelineDay>>();
    for (const row of dailyCounts) {
      let dates = bySystem.get(row.system_key);
      if (!dates) {
        dates = new Map();
        bySystem.set(row.system_key, dates);
      }
      dates.set(row.day, {
        date: row.day,
        status: row.down_check_count > 0 ? 'down' : row.degraded_check_count > 0 ? 'degraded'
          : row.up_check_count > 0 ? 'up' : row.skipped_check_count > 0 ? 'skipped' : 'none',
        checkCount: row.check_count,
        observedCheckCount: row.observed_check_count,
        upCheckCount: row.up_check_count,
      });
    }
    return getHandlerSystemKeys().map((systemKey) => {
      const dates = bySystem.get(systemKey);
      const days = dayRange.map((date) => dates?.get(date) ?? {
        date, status: 'none' as const, checkCount: 0, observedCheckCount: 0, upCheckCount: 0,
      });
      return { systemKey, label: SYSTEM_LABELS[systemKey] ?? systemKey, days, uptimePercent: computeTimelineUptime(days) };
    });
  }
  const rows = await loadStatusHistory(since, until);

  const bySystem = new Map<string, Map<string, string[]>>();
  const datesInRange = new Set(dayRange);
  for (const row of rows) {
    const dateKey = utcDateKey(new Date(row.created_at));
    if (!datesInRange.has(dateKey)) continue;
    let systemMap = bySystem.get(row.system_key);
    if (!systemMap) {
      systemMap = new Map();
      bySystem.set(row.system_key, systemMap);
    }
    const list = systemMap.get(dateKey) ?? [];
    list.push(normalizeHealthStatus(row.status, row.health_payload?.checks ?? {}));
    systemMap.set(dateKey, list);
  }

  const allKeys = getHandlerSystemKeys();
  return allKeys.map((systemKey) => {
    const rowsByDate = bySystem.get(systemKey) ?? new Map();
    return buildSystemTimeline(systemKey, dayRange, rowsByDate);
  });
}
