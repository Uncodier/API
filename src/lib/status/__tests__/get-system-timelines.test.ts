import {
  aggregateDayStatus,
  buildSystemTimeline,
  computeTimelineUptime,
} from '@/lib/status/get-system-timelines';

describe('get-system-timelines', () => {
  it('aggregateDayStatus picks worst status', () => {
    expect(aggregateDayStatus(['up', 'up', 'degraded'])).toBe('degraded');
    expect(aggregateDayStatus(['up', 'down'])).toBe('down');
    expect(aggregateDayStatus([])).toBe('none');
  });

  it('computeTimelineUptime excludes none days', () => {
    const days = [
      { date: '2026-01-01', status: 'up' as const, checkCount: 1 },
      { date: '2026-01-02', status: 'none' as const, checkCount: 0 },
      { date: '2026-01-03', status: 'down' as const, checkCount: 1 },
    ];
    expect(computeTimelineUptime(days)).toBe(50);
  });

  it('computeTimelineUptime returns null when no checks', () => {
    const days = [{ date: '2026-01-01', status: 'none' as const, checkCount: 0 }];
    expect(computeTimelineUptime(days)).toBeNull();
  });

  it('buildSystemTimeline returns 90 days', () => {
    const range = Array.from({ length: 90 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
    const timeline = buildSystemTimeline('ai_text', range, new Map());
    expect(timeline.days).toHaveLength(90);
    expect(timeline.days.every((d) => d.status === 'none')).toBe(true);
  });
});
