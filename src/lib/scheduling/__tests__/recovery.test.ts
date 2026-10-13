import { buildSchedulingDateContext, buildSchedulingRecovery } from '../recovery';

describe('authoritative scheduling dates', () => {
  it('uses the local day near UTC midnight, not a UTC calendar date', () => {
    const now = new Date('2026-10-13T01:30:00.000Z');
    expect(buildSchedulingDateContext('America/Mexico_City', now)).toEqual({
      current_time_utc: now.toISOString(), local_date: '2026-10-12',
      tomorrow: '2026-10-13', timezone: 'America/Mexico_City',
    });
  });

  it.each([
    ['2026-12-31T23:00:00Z', 'UTC', '2026-12-31', ['2027-01-01', '2027-01-02', '2027-01-03']],
    ['2028-02-28T23:00:00Z', 'UTC', '2028-02-28', ['2028-02-29', '2028-03-01', '2028-03-02']],
    ['2026-03-08T04:30:00Z', 'America/New_York', '2026-03-07', ['2026-03-08', '2026-03-09', '2026-03-10']],
    ['2026-11-01T03:30:00Z', 'America/New_York', '2026-10-31', ['2026-11-01', '2026-11-02', '2026-11-03']],
    ['2026-12-31T12:00:00Z', 'Pacific/Kiritimati', '2027-01-01', ['2027-01-02', '2027-01-03', '2027-01-04']],
  ])('gives three future calendar dates through boundaries: %s %s', (iso, timezone, today, dates) => {
    const recovery = buildSchedulingRecovery({ timezone: timezone as string, now: new Date(iso as string), code: 'CALENDAR_NOT_FOUND' });
    expect(recovery).toMatchObject({ local_date: today, tomorrow: dates[0], suggested_dates: dates,
      availability_confirmed: false, auto_retry: false, code: 'CALENDAR_NOT_FOUND' });
    expect(recovery.suggested_dates.every(date => date > recovery.local_date)).toBe(true);
    expect(recovery).not.toHaveProperty('slots');
    expect(recovery).not.toHaveProperty('available_slots');
    expect(recovery.guidance).toMatch(/NOT available slots/);
    expect(recovery.guidance).toContain('calendars action="list"');
    expect(recovery.guidance).toContain('list current appointments');
  });

  it.each([undefined, '', 'Not/A_Timezone'])('uses the explicit canonical fallback timezone for %s', timezone => {
    const result = buildSchedulingDateContext(timezone, new Date('2026-10-13T01:30:00Z'));
    expect(result.timezone).toBe('America/Mexico_City');
    expect(result.local_date).toBe('2026-10-12');
  });

  it('samples the live clock on every invocation without mutating now', () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-10-13T23:59:59Z');
      jest.setSystemTime(now);
      const before = buildSchedulingDateContext('UTC');
      jest.setSystemTime(new Date('2026-10-14T00:00:01Z'));
      const after = buildSchedulingDateContext('UTC');
      expect(before.local_date).toBe('2026-10-13');
      expect(after.local_date).toBe('2026-10-14');
      buildSchedulingRecovery({ now });
      expect(now.toISOString()).toBe('2026-10-13T23:59:59.000Z');
    } finally { jest.useRealTimers(); }
  });
});