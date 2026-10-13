import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { GET } from '../../src/app/api/agents/tools/scheduling/availability/route';
import { getSchedulingAvailability } from '../../src/lib/scheduling/availability';
import { SchedulingAvailabilityError } from '../../src/lib/scheduling/calendar-directory';

jest.mock('../../src/lib/scheduling/availability', () => ({ getSchedulingAvailability: jest.fn() }));

describe('availability endpoint recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T00:08:18Z'));
  });
  afterEach(() => jest.useRealTimers());
  const request = () => new NextRequest('https://api.example.test/api/agents/tools/scheduling/availability?date=2026-10-09&timezone=America%2FMexico_City&duration=30&site_id=11111111-1111-4111-8111-111111111111');

  it('returns a current local clock and future suggestions on rejected dates without inventing slots', async () => {
    (getSchedulingAvailability as jest.Mock).mockRejectedValue(new SchedulingAvailabilityError('DATE_IN_PAST', 'No se pueden consultar fechas en el pasado'));
    const result = await GET(request());
    expect(result.status).toBe(422);
    const body = await result.json();
    expect(body).toMatchObject({ success: false, code: 'DATE_IN_PAST', recovery: {
      current_time_utc: '2026-10-13T00:08:18.000Z', local_date: '2026-10-12', tomorrow: '2026-10-13',
      suggested_dates: ['2026-10-13', '2026-10-14', '2026-10-15'], availability_confirmed: false,
    } });
    expect(body).not.toHaveProperty('available_slots');
    expect(result.headers.get('cache-control')).toBe('no-store');
  });

  it('returns safe suggestions even on unexpected database/network exceptions', async () => {
    const secret = randomBytes(24).toString('hex');
    (getSchedulingAvailability as jest.Mock).mockRejectedValue(new Error(`password=${secret}`));
    const result = await GET(request());
    expect(result.status).toBe(503);
    const body = await result.json();
    expect(body.recovery.availability_confirmed).toBe(false);
    expect(body.code).toBe('AVAILABILITY_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('forwards real successful slots without adding speculative fallback dates', async () => {
    (getSchedulingAvailability as jest.Mock).mockResolvedValue({ success: true, available_slots: [] });
    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ success: true, available_slots: [] });
  });
});