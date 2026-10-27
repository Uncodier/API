const mockFrom = jest.fn();
const mockGetHandlerSystemKeys = jest.fn();
const mockDailyCounts = jest.fn();
jest.mock('@/lib/status/history-aggregates', () => ({ getDailyStatusCounts: mockDailyCounts }));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: mockFrom },
}));

// Never import real handlers: they can initialize network/provider clients.
jest.mock('@/lib/status/handler-registry', () => ({
  getHandlerSystemKeys: mockGetHandlerSystemKeys,
}));

import {
  aggregateDayStatus,
  buildSystemTimeline,
  computeTimelineUptime,
  getSystemTimelines,
  loadStatusHistory,
  timelineHasProbeData,
  type StatusHistoryRow,
} from '@/lib/status/get-system-timelines';

const NOW = '2026-10-20T12:00:00.000Z';

function historyRow(id: string, overrides: Partial<StatusHistoryRow> = {}): StatusHistoryRow {
  return {
    id,
    system_key: 'ai_text',
    status: 'up',
    created_at: '2026-10-19T08:00:00.000Z',
    health_payload: null,
    ...overrides,
  };
}

function mockHistory(rows: StatusHistoryRow[], serverCap = 500, onPage?: () => void) {
  const queries: Array<{
    select: jest.Mock;
    gte: jest.Mock;
    lte: jest.Mock;
    order: jest.Mock;
    range: jest.Mock;
    abortSignal: jest.Mock;
  }> = [];
  mockFrom.mockImplementation(() => {
    const query = {
      select: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      abortSignal: jest.fn(async () => {
        const [start, end] = query.range.mock.calls[0] as [number, number];
        onPage?.();
        const since = query.gte.mock.calls[0][1] as string;
        const until = query.lte.mock.calls[0][1] as string;
        const ordered = rows
          .filter((row) => row.created_at >= since && row.created_at <= until)
          .sort((a, b) => {
            for (const [field, options] of query.order.mock.calls) {
              const key = field as 'created_at' | 'id';
              const comparison = a[key].localeCompare(b[key]);
              if (comparison) return options.ascending ? comparison : -comparison;
            }
            return 0;
          });
        return { data: ordered.slice(start, Math.min(end + 1, start + serverCap)), error: null };
      }),
    };
    queries.push(query);
    return query;
  });
  return queries;
}

describe('get-system-timelines', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockDailyCounts.mockResolvedValue(null);
    jest.useFakeTimers().setSystemTime(new Date(NOW));
    mockGetHandlerSystemKeys.mockReturnValue(['ai_text', 'notifications']);
    mockHistory([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses compact daily counts with the same weighted metrics, without raw history queries', async () => {
    mockDailyCounts.mockResolvedValue([{ system_key: 'ai_text', day: '2026-10-20', check_count: 12,
      observed_check_count: 10, up_check_count: 9, degraded_check_count: 0, down_check_count: 1, skipped_check_count: 2 }]);
    const timelines = await getSystemTimelines();
    expect(timelines[0].uptimePercent).toBe(90);
    expect(timelines[0].days.at(-1)).toMatchObject({ status: 'down', checkCount: 12, observedCheckCount: 10, upCheckCount: 9 });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('never falls back to expensive raw queries after a real aggregate outage', async () => {
    mockDailyCounts.mockRejectedValue(new Error('Aggregate unavailable'));
    await expect(getSystemTimelines()).rejects.toThrow('Aggregate unavailable');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('aggregateDayStatus picks worst status', () => {
    expect(aggregateDayStatus(['up', 'up', 'degraded'])).toBe('degraded');
    expect(aggregateDayStatus(['up', 'down'])).toBe('down');
    expect(aggregateDayStatus(['skipped', 'up'])).toBe('up');
    expect(aggregateDayStatus(['skipped'])).toBe('skipped');
    expect(aggregateDayStatus(['unknown'])).toBe('none');
    expect(aggregateDayStatus([])).toBe('none');
  });

  it('computeTimelineUptime weights legacy days by checkCount and excludes no evidence', () => {
    const days = [
      { date: '2026-01-01', status: 'up' as const, checkCount: 9 },
      { date: '2026-01-02', status: 'none' as const, checkCount: 0 },
      { date: '2026-01-03', status: 'down' as const, checkCount: 1 },
      { date: '2026-01-04', status: 'skipped' as const, checkCount: 30 },
    ];
    expect(computeTimelineUptime(days)).toBe(90);
  });

  it('computeTimelineUptime returns null when no checks', () => {
    const days = [{ date: '2026-01-01', status: 'none' as const, checkCount: 0 }];
    expect(computeTimelineUptime(days)).toBeNull();
    expect(computeTimelineUptime([])).toBeNull();
    expect(computeTimelineUptime([{ date: '2026-01-01', status: 'up', checkCount: 0 }])).toBeNull();
  });

  it('buildSystemTimeline returns 90 days', () => {
    const range = Array.from({ length: 90 }, (_, i) => {
      const date = new Date(NOW);
      date.setUTCDate(date.getUTCDate() - (89 - i));
      return date.toISOString().slice(0, 10);
    });
    const timeline = buildSystemTimeline('ai_text', range, new Map());
    expect(timeline.days).toHaveLength(90);
    expect(timeline.days.every((d) => d.status === 'none')).toBe(true);
    expect(timeline.days.every((d) => d.checkCount === 0 && d.observedCheckCount === 0 && d.upCheckCount === 0)).toBe(true);
    expect(timeline.uptimePercent).toBeNull();
    expect(timeline.label).toBe('AI Text');
    expect(timelineHasProbeData(timeline.days)).toBe(false);
  });

  it('preserves the worst day while counting individual successful observed checks', () => {
    const timeline = buildSystemTimeline('unregistered', ['2026-10-18', '2026-10-19', '2026-10-20'], new Map([
      ['2026-10-18', ['up', 'up', 'up', 'down', 'skipped', 'unknown']],
      ['2026-10-19', ['up', 'degraded']],
      ['2026-10-20', ['skipped', 'skipped']],
    ]));
    expect(timeline.days).toEqual([
      { date: '2026-10-18', status: 'down', checkCount: 6, observedCheckCount: 4, upCheckCount: 3 },
      { date: '2026-10-19', status: 'degraded', checkCount: 2, observedCheckCount: 2, upCheckCount: 1 },
      { date: '2026-10-20', status: 'skipped', checkCount: 2, observedCheckCount: 0, upCheckCount: 0 },
    ]);
    expect(timeline.uptimePercent).toBe(66.7);
    expect(timeline.label).toBe('unregistered');
  });

  it.each([500, 137])('exhausts >1000 same-timestamp rows and includes recent failures with server cap %i', async (cap) => {
    const oldRows = Array.from({ length: 1251 }, (_, i) => historyRow(String(i).padStart(5, '0'))).reverse();
    const rows = [historyRow('recent', { status: 'down', created_at: '2026-10-20T11:59:59.000Z' }), ...oldRows];
    const queries = mockHistory(rows, cap);

    const [timeline, emptySystem] = await getSystemTimelines(2);

    expect(timeline.days).toEqual([
      { date: '2026-10-19', status: 'up', checkCount: 1251, observedCheckCount: 1251, upCheckCount: 1251 },
      { date: '2026-10-20', status: 'down', checkCount: 1, observedCheckCount: 1, upCheckCount: 0 },
    ]);
    expect(timeline.uptimePercent).toBe(99.9);
    expect(emptySystem.uptimePercent).toBeNull();
    expect(queries.map((query) => query.range.mock.calls[0][0])).toEqual([
      ...Array.from({ length: Math.ceil(rows.length / cap) }, (_, i) => i * cap), rows.length,
    ]);
    for (const query of queries) {
      expect(query.select).toHaveBeenCalledWith('id, system_key, status, created_at, health_payload');
      expect(query.order.mock.calls).toEqual([
        ['created_at', { ascending: true }], ['id', { ascending: true }],
      ]);
      const [start, end] = query.range.mock.calls[0];
      expect(end - start + 1).toBeLessThanOrEqual(500);
      expect(query.gte).toHaveBeenCalledWith('created_at', '2026-10-19T00:00:00.000Z');
      expect(query.lte).toHaveBeenCalledWith('created_at', NOW);
    }
    expect(mockFrom.mock.calls.every(([table]) => table === 'system_status')).toBe(true);
    expect(mockGetHandlerSystemKeys).toHaveBeenCalledTimes(1);
  });

  it('returns every history id exactly once in deterministic timestamp/id order', async () => {
    const rows = Array.from({ length: 1105 }, (_, i) => historyRow(String(i).padStart(5, '0'))).reverse();
    mockHistory(rows, 113);
    const loaded = await loadStatusHistory('2026-10-19T00:00:00.000Z', NOW);
    expect(loaded.map((row) => row.id)).toEqual(rows.map((row) => row.id).sort());
    expect(new Set(loaded.map((row) => row.id)).size).toBe(rows.length);
  });

  it('shares one 20-second abort signal across all raw history pages, including the terminal page', async () => {
    const rows = Array.from({ length: 1101 }, (_, i) => historyRow(String(i)));
    const queries = mockHistory(rows, 137);
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    try {
      expect(await loadStatusHistory('2026-10-19T00:00:00.000Z', NOW)).toHaveLength(rows.length);
      expect(queries.length).toBeGreaterThan(2);
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(20000);
      const signal = timeout.mock.results[0].value;
      expect(signal).toBeInstanceOf(AbortSignal);
      for (const query of queries) {
        expect(query.range).toHaveBeenCalledTimes(1);
        expect(query.abortSignal).toHaveBeenCalledTimes(1);
        expect(query.abortSignal).toHaveBeenCalledWith(signal);
        expect(query.range.mock.invocationCallOrder[0]).toBeLessThan(query.abortSignal.mock.invocationCallOrder[0]);
      }
    } finally {
      timeout.mockRestore();
    }
  });

  it('uses one fixed upper timestamp and UTC day range across every page', async () => {
    const queries = mockHistory([
      historyRow('too-old', { created_at: '2026-10-18T23:59:59.999Z' }),
      historyRow('start', { created_at: '2026-10-19T00:00:00.000Z' }),
      historyRow('end', { created_at: NOW }),
      historyRow('future', { status: 'down', created_at: '2026-10-20T12:00:00.001Z' }),
    ], 1, () => jest.setSystemTime(new Date('2026-10-21T00:01:00.000Z')));
    const [timeline] = await getSystemTimelines(2);
    expect(timeline.days.map((day) => [day.date, day.checkCount])).toEqual([
      ['2026-10-19', 1], ['2026-10-20', 1],
    ]);
    expect(timeline.uptimePercent).toBe(100);
    expect(queries).toHaveLength(3);
    for (const query of queries) expect(query.lte).toHaveBeenCalledWith('created_at', NOW);
  });

  it.each([0, -1, 91, 1.5, NaN, Infinity])('rejects invalid dayCount %s before accessing DB', async (dayCount) => {
    await expect(getSystemTimelines(dayCount)).rejects.toThrow(RangeError);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each([1, 90, undefined])('returns the requested valid range %s for empty history', async (dayCount) => {
    const timelines = await getSystemTimelines(dayCount);
    expect(timelines).toHaveLength(2);
    for (const timeline of timelines) {
      expect(timeline.days).toHaveLength(dayCount ?? 90);
      expect(timeline.days[timeline.days.length - 1].date).toBe('2026-10-20');
      expect(timeline.days.every((day) => day.status === 'none' && day.checkCount === 0)).toBe(true);
      expect(timeline.uptimePercent).toBeNull();
    }
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('propagates DB errors on page %i instead of returning empty or partial timelines', async (page) => {
    const queries = mockHistory(page ? [historyRow('one')] : [], 1);
    const error = { message: 'database unavailable', code: 'XX000' };
    mockFrom.mockImplementationOnce(() => {
      const query = {
        select: jest.fn().mockReturnThis(), gte: jest.fn().mockReturnThis(),
        lte: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        abortSignal: jest.fn().mockResolvedValue(page ? { data: [historyRow('one')], error: null } : { data: null, error }),
      };
      queries.push(query);
      return query;
    });
    if (page) mockFrom.mockImplementationOnce(() => ({
      select: jest.fn().mockReturnThis(), gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      abortSignal: jest.fn().mockResolvedValue({ data: null, error }),
    }));
    await expect(getSystemTimelines(2)).rejects.toThrow('database unavailable');
    expect(mockGetHandlerSystemKeys).not.toHaveBeenCalled();
  });

  it('does not reinterpret a transport rejection as an empty history', async () => {
    const getQuery = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation(() => {
      const query = getQuery();
      query.abortSignal.mockRejectedValue(new Error('network unavailable'));
      return query;
    });
    await expect(getSystemTimelines()).rejects.toThrow('network unavailable');
  });

  it('rejects an unexpected null data response without an error', async () => {
    const queries = mockHistory([]);
    const getQuery = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation(() => {
      const query = getQuery();
      query.abortSignal.mockResolvedValue({ data: null, error: null });
      return query;
    });
    await expect(getSystemTimelines()).rejects.toThrow('returned no data');
    expect(queries).toHaveLength(1);
  });

  it.each([
    ['configuration', { verification: 'configuration' }],
    ['unverified', { verification: 'unverified' }],
    ['no telemetry', { telemetryFound: false }],
    ['notification registration only', { routesRegistered: true, sideEffectSafe: true }],
    ['providers configuration only', { providers: {
      first: { configured: true, verification: 'configuration', liveProbe: false },
      second: { configured: true, verification: 'configuration', liveProbe: false },
    } }],
    ['inherited configuration only', { inheritedProviders: {
      first: { configured: true, verification: 'configuration', liveProbe: false },
    } }],
  ])('normalizes legacy %s rows to skipped without counting them as outages', async (_name, checks) => {
    mockHistory([historyRow('legacy', { status: 'degraded', health_payload: { checks } })]);
    const [timeline] = await getSystemTimelines(2);
    expect(timeline.days[0]).toEqual({
      date: '2026-10-19', status: 'skipped', checkCount: 1, observedCheckCount: 0, upCheckCount: 0,
    });
    expect(timeline.uptimePercent).toBeNull();
  });

  it('preserves real degraded/down checks, including mixed verified providers and missing legacy payloads', async () => {
    mockHistory([
      historyRow('old', { status: 'degraded' }),
      historyRow('empty-checks', { status: 'up', health_payload: {} }),
      historyRow('mixed', { status: 'degraded', health_payload: { checks: { providers: {
        ready: { configured: true, verification: 'configuration', liveProbe: false },
        failed: { configured: true, verification: 'inference', liveProbe: false },
      } } } }),
      historyRow('down', { status: 'down', health_payload: { checks: { verification: 'configuration' } } }),
      historyRow('skipped', { status: 'skipped' }),
    ]);
    const [timeline] = await getSystemTimelines(2);
    expect(timeline.days[0]).toEqual({
      date: '2026-10-19', status: 'down', checkCount: 5, observedCheckCount: 4, upCheckCount: 1,
    });
    expect(timeline.uptimePercent).toBe(25);
  });
});
