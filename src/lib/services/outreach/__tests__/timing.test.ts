import { outreachTimingReason, validOutreachTiming } from '../timing';
import { getOutreachPolicy } from '../policy';

describe.each(['leads_follow_up', 'leads_initial_cold_outreach'] as const)('%s timing', activity => {
  const settings = (timing: any, hours: any = { timezone: 'UTC', days: { tuesday: { start: '10:30' } } }) => ({
    business_hours: hours, activities: { [activity]: { status: 'active', ...timing } },
  });
  const now = new Date('2026-09-29T10:00:00Z');
  it.each([{ start_time_mode: null }, { start_time_mode: 'wrong' }, { start_time_mode: 'custom' },
    { start_time: null }, { start_time: '24:00' }, { start_time: '09:00\n' }])('rejects invalid %j', timing => {
    expect(validOutreachTiming(timing)).toBe(false);
    expect(getOutreachPolicy(settings(timing), activity)).toBeNull();
    expect(outreachTimingReason(settings(timing), activity, now)).toBe('invalid_outreach_configuration');
  });
  it('preserves unconfigured legacy behavior and enforces custom boundary', () => {
    expect(outreachTimingReason(settings({}), activity, now)).toBeUndefined();
    expect(outreachTimingReason(settings({ start_time_mode: 'custom', start_time: '10:30' }), activity, now)).toBe('before_start_time');
    expect(outreachTimingReason(settings({ start_time: '10:00' }), activity, now)).toBeUndefined();
  });
  it.each(['23:59', null, 'invalid'])('opening supersedes retained override %j', start_time => {
    const input = settings({ start_time_mode: 'business_opening', start_time });
    expect(outreachTimingReason(input, activity, now)).toBe('before_start_time');
    expect(outreachTimingReason(input, activity, new Date('2026-09-29T10:30:00Z'))).toBeUndefined();
  });
  it('opening skips disabled days and uses 09:00 fallback for missing openings', () => {
    const timing = { start_time_mode: 'business_opening' };
    expect(outreachTimingReason(settings(timing, { timezone: 'UTC', days: { tuesday: { enabled: false } } }), activity, now)).toBe('business_closed');
    expect(outreachTimingReason(settings(timing, { timezone: 'UTC' }), activity, new Date('2026-09-29T08:59:59Z'))).toBe('before_start_time');
    expect(outreachTimingReason(settings(timing, { timezone: 'UTC' }), activity, new Date('2026-09-29T09:00:00Z'))).toBeUndefined();
  });
  it('uses local dates, legacy object openings and fractional timezone offsets', () => {
    const input = settings({ start_time_mode: 'business_opening' }, [{ timezone: 'Asia/Kathmandu', tuesday: { open: '00:15' } }]);
    expect(outreachTimingReason(input, activity, new Date('2026-09-28T18:29:59Z'))).toBe('before_start_time');
    expect(outreachTimingReason(input, activity, new Date('2026-09-28T18:30:00Z'))).toBeUndefined();
  });
  it.each(['Invalid/Zone', '', 12])('fails closed for timezone %j', timezone => {
    expect(outreachTimingReason(settings({}, { timezone }), activity, now)).toBe('invalid_timezone');
  });
  it('only cold custom timing keeps operating-day restrictions', () => {
    const input = settings({ start_time_mode: 'custom', start_time: '10:00' }, { timezone: 'UTC', days: { tuesday: { enabled: false } } });
    expect(outreachTimingReason(input, activity, now)).toBe(activity === 'leads_initial_cold_outreach' ? 'business_closed' : undefined);
  });
});