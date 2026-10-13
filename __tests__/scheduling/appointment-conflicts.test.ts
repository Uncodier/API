import { supabaseAdmin } from '../../src/lib/database/supabase-client';
import { checkAppointmentAvailability } from '../../src/lib/scheduling/appointments';
import { loadSchedulingDirectory } from '../../src/lib/scheduling/calendar-directory';

jest.mock('../../src/lib/database/supabase-client', () => ({ supabaseAdmin: { schema: jest.fn() } }));
jest.mock('../../src/lib/scheduling/calendar-directory', () => ({ loadSchedulingDirectory: jest.fn() }));

describe('appointment overlap at booking time', () => {
  let query: any;
  let rows: any[];
  let error: any;
  const start = '2026-10-13T16:00:00.000Z', end = '2026-10-13T16:30:00.000Z';
  beforeEach(() => {
    jest.clearAllMocks();
    rows = []; error = null;
    query = {};
    for (const method of ['from', 'select', 'eq', 'lt', 'gt', 'neq']) query[method] = jest.fn().mockReturnValue(query);
    query.then = (resolve: any, reject: any) => Promise.resolve({ data: rows, error }).then(resolve, reject);
    (supabaseAdmin.schema as jest.Mock).mockReturnValue(query);
  });

  it('queries true interval overlaps, including an existing appointment that encloses the slot', async () => {
    rows = [{ start_datetime: '2026-10-13T15:00:00Z', end_datetime: '2026-10-13T17:00:00Z', participants: ['member'] }];
    expect(await checkAppointmentAvailability(start, end, 'site', ['member'])).toBe(false);
    expect(query.lt).toHaveBeenCalledWith('start_datetime', end);
    expect(query.gt).toHaveBeenCalledWith('end_datetime', start);
    expect(query.eq).toHaveBeenCalledWith('site_id', 'site');
    expect(query.eq).toHaveBeenCalledWith('status', 'confirmed');
  });

  it('allows another participant but fails closed for legacy unassigned appointments and DB errors', async () => {
    rows = [{ participants: ['other'] }];
    expect(await checkAppointmentAvailability(start, end, 'site', ['member'])).toBe(true);
    rows = [{ participants: [] }];
    expect(await checkAppointmentAvailability(start, end, 'site', ['member'])).toBe(false);
    rows = []; error = { message: 'unavailable' };
    expect(await checkAppointmentAvailability(start, end, 'site', ['member'])).toBe(false);
  });

  it('blocks legacy email bookings for the same site-bound UUID regardless of email case/whitespace', async () => {
    rows = [{ participants: [' Member@Example.Test '] }];
    (loadSchedulingDirectory as jest.Mock).mockResolvedValue({ members: [{ id: 'member', email: 'member@example.test' }] });
    expect(await checkAppointmentAvailability(start, end, 'site', ['member'])).toBe(false);
    expect(loadSchedulingDirectory).toHaveBeenCalledWith('site');
    (loadSchedulingDirectory as jest.Mock).mockRejectedValue(new Error('Unavailable directory'));
    expect(await checkAppointmentAvailability(start, end, 'site', ['member'])).toBe(false);
  });
});