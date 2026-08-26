import { buildDateContextSection } from '../dateContext';
import { parseInstantOrWallClock, localDateBoundsToUtc, resolvePeriodBounds } from '../periodBounds';
import { computeAppliedRange, coerceDateOnlyBound } from '../queryRange';

const MX = 'America/Mexico_City';

describe('periodBounds America/Mexico_City', () => {
  // 2026-08-14 21:26 UTC = 2026-08-14 15:26 in Mexico (UTC-6, no DST)
  const fridayAfternoonUtc = new Date('2026-08-14T21:26:00.000Z');

  it('maps today to Mexico midnight UTC bounds', () => {
    const range = resolvePeriodBounds(MX, 'today', fridayAfternoonUtc);
    expect(range.local_start).toBe('2026-08-14');
    expect(range.local_end).toBe('2026-08-14');
    expect(range.start_utc).toBe('2026-08-14T06:00:00.000Z');
    expect(range.end_utc).toBe('2026-08-15T06:00:00.000Z');
    expect(range.period).toBe('today');
  });

  it('keeps "today" on Aug 14 when UTC has already rolled to Aug 15', () => {
    const stillThursdayMx = new Date('2026-08-15T05:00:00.000Z');
    const range = resolvePeriodBounds(MX, 'today', stillThursdayMx);
    expect(range.local_start).toBe('2026-08-14');
    expect(range.start_utc).toBe('2026-08-14T06:00:00.000Z');
  });

  it('rolls to Aug 15 after Mexico midnight', () => {
    const afterMxMidnight = new Date('2026-08-15T07:00:00.000Z');
    const range = resolvePeriodBounds(MX, 'today', afterMxMidnight);
    expect(range.local_start).toBe('2026-08-15');
    expect(range.start_utc).toBe('2026-08-15T06:00:00.000Z');
    expect(range.end_utc).toBe('2026-08-16T06:00:00.000Z');
  });

  it('uses Monday-Sunday ISO weeks', () => {
    const range = resolvePeriodBounds(MX, 'this_week', fridayAfternoonUtc);
    expect(range.local_start).toBe('2026-08-10');
    expect(range.local_end).toBe('2026-08-16');
    expect(range.start_utc).toBe('2026-08-10T06:00:00.000Z');
    expect(range.end_utc).toBe('2026-08-17T06:00:00.000Z');
  });

  it('starts a new week after Mexico Monday midnight', () => {
    const sundayMx = new Date('2026-08-16T20:00:00.000Z');
    const stillThisWeek = resolvePeriodBounds(MX, 'this_week', sundayMx);
    expect(stillThisWeek.local_start).toBe('2026-08-10');

    const mondayMx = new Date('2026-08-17T07:00:00.000Z');
    const nextWeek = resolvePeriodBounds(MX, 'this_week', mondayMx);
    expect(nextWeek.local_start).toBe('2026-08-17');
    expect(nextWeek.local_end).toBe('2026-08-23');
  });

  it('resolves last_week as the previous Monday-Sunday', () => {
    const range = resolvePeriodBounds(MX, 'last_week', fridayAfternoonUtc);
    expect(range.local_start).toBe('2026-08-03');
    expect(range.local_end).toBe('2026-08-09');
  });

  it('resolves this_month and last_month across month boundaries', () => {
    const thisMonth = resolvePeriodBounds(MX, 'this_month', fridayAfternoonUtc);
    expect(thisMonth.local_start).toBe('2026-08-01');
    expect(thisMonth.local_end).toBe('2026-08-31');
    expect(thisMonth.start_utc).toBe('2026-08-01T06:00:00.000Z');
    expect(thisMonth.end_utc).toBe('2026-09-01T06:00:00.000Z');

    const lastMonth = resolvePeriodBounds(MX, 'last_month', fridayAfternoonUtc);
    expect(lastMonth.local_start).toBe('2026-07-01');
    expect(lastMonth.local_end).toBe('2026-07-31');

    const stillAugust = resolvePeriodBounds(MX, 'this_month', new Date('2026-09-01T05:00:00.000Z'));
    expect(stillAugust.local_start).toBe('2026-08-01');

    const september = resolvePeriodBounds(MX, 'this_month', new Date('2026-09-01T07:00:00.000Z'));
    expect(september.local_start).toBe('2026-09-01');
    expect(september.local_end).toBe('2026-09-30');
  });

  it('converts local YYYY-MM-DD bounds to exclusive UTC', () => {
    const range = localDateBoundsToUtc(MX, '2026-08-14', '2026-08-16');
    expect(range.start_utc).toBe('2026-08-14T06:00:00.000Z');
    expect(range.end_utc).toBe('2026-08-17T06:00:00.000Z');
    expect(range.local_start).toBe('2026-08-14');
    expect(range.local_end).toBe('2026-08-16');
  });
});

describe('computeAppliedRange', () => {
  const now = new Date('2026-08-14T21:26:00.000Z');

  it('prefers date_from/date_to over period', () => {
    const range = computeAppliedRange(MX, {
      period: 'today',
      date_from: '2026-08-01',
      date_to: '2026-08-07',
      now,
    });
    expect(range?.local_start).toBe('2026-08-01');
    expect(range?.local_end).toBe('2026-08-07');
  });

  it('treats a single date_from as one local day', () => {
    const range = computeAppliedRange(MX, { date_from: '2026-08-14', now });
    expect(range?.start_utc).toBe('2026-08-14T06:00:00.000Z');
    expect(range?.end_utc).toBe('2026-08-15T06:00:00.000Z');
  });

  it('coerces YYYY-MM-DD to UTC start/end inclusive', () => {
    expect(coerceDateOnlyBound('2026-08-14', MX, 'start')).toBe('2026-08-14T06:00:00.000Z');
    expect(coerceDateOnlyBound('2026-08-14', MX, 'endInclusive')).toBe('2026-08-15T05:59:59.999Z');
    expect(coerceDateOnlyBound('2026-08-14T12:00:00Z', MX, 'start')).toBe('2026-08-14T12:00:00Z');
  });
});

describe('buildDateContextSection', () => {
  it('includes both clocks and precomputed bounds', () => {
    const text = buildDateContextSection(MX, new Date('2026-08-14T21:26:00.000Z'));
    expect(text).toContain('Server UTC: 2026-08-14T21:26:00.000Z');
    expect(text).toContain('Client timezone: America/Mexico_City');
    expect(text).toContain('gte 2026-08-14T06:00:00.000Z');
    expect(text).toContain('CLIENT local time');
  });
});

describe('parseInstantOrWallClock', () => {
  it('treats naive 12:00 as CDMX wall-clock (18:00Z), not 12:00Z', () => {
    expect(parseInstantOrWallClock('2026-07-27T12:00:00', MX).toISOString()).toBe('2026-07-27T18:00:00.000Z');
    expect(parseInstantOrWallClock('2026-07-27T18:00:00.000Z', MX).toISOString()).toBe('2026-07-27T18:00:00.000Z');
  });
});
