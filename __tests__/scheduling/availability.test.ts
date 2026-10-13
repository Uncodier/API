import { getSchedulingAvailability } from '../../src/lib/scheduling/availability';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';

jest.mock('../../src/lib/database/supabase-client', () => ({ supabaseAdmin: { schema: jest.fn(), from: jest.fn() } }));

const SITE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const CALENDAR = '44444444-4444-4444-8444-444444444444';
const MX = 'America/Mexico_City';
const now = new Date('2026-10-13T00:08:18Z');
const input = { site_id: SITE, date: '2026-10-13', timezone: MX, duration: 30 };

function chain(data: unknown, error: unknown = null) {
  const result: any = {};
  for (const method of ['select', 'eq', 'in', 'lt', 'gt']) result[method] = jest.fn().mockReturnValue(result);
  result.maybeSingle = jest.fn().mockResolvedValue({ data, error });
  result.then = (resolve: any, reject: any) => Promise.resolve({ data, error }).then(resolve, reject);
  return result;
}

describe('calendar-backed scheduling availability', () => {
  let tables: Record<string, any>;
  let settings: any;
  let profiles: any[];
  beforeEach(() => {
    jest.clearAllMocks();
    settings = { calendars: [{ id: CALENDAR, name: 'Demo', member_ids: ['member@example.test'], buffer: 15 }],
      business_hours: [{ timezone: MX, days: { tuesday: { enabled: true, start: '09:00', end: '18:00' } } }] };
    profiles = [{ id: USER, name: 'Member', email: 'member@example.test', settings: { calendar: {
      enabled: true, timezone: MX, availability: { tuesday: { enabled: true, start: '10:00', end: '17:00', breaks: [{ start: '12:00', end: '13:00' }] } },
    } } }];
    tables = {
      settings: chain(settings), site_ownership: chain([{ user_id: USER }]), site_members: chain([]),
      profiles: chain(profiles), appointments: chain([]), calendar_blocks: chain([]),
    };
    (supabaseAdmin.schema as jest.Mock).mockReturnValue(supabaseAdmin);
    (supabaseAdmin.from as jest.Mock).mockImplementation(table => {
      if (!tables[table]) throw new Error(`Unexpected table: ${table}`);
      return tables[table];
    });
  });

  it('resolves the unique calendar and legacy email to a site member; respects hours and breaks', async () => {
    const result = await getSchedulingAvailability(input, now);
    expect(result.calendar_id).toBe(CALENDAR);
    expect(result.available_slots[0]).toMatchObject({ start: '10:00', start_utc: '2026-10-13T16:00:00.000Z', available_participants: [{ id: USER, name: 'Member', role: 'owner' }] });
    expect(result.available_slots.map(slot => slot.start)).not.toEqual(expect.arrayContaining(['09:00', '12:00', '12:30', '17:00']));
    expect(JSON.stringify(result)).not.toContain('member@example.test');
    expect(tables.profiles.in).toHaveBeenCalledWith('id', [USER]);
    expect(tables.site_members.eq).toHaveBeenCalledWith('status', 'active');
    expect(tables.appointments.eq).toHaveBeenCalledWith('site_id', SITE);
    expect(tables.appointments.lt).toHaveBeenCalledWith('start_datetime', '2026-10-14T06:15:00.000Z');
    expect(tables.appointments.gt).toHaveBeenCalledWith('end_datetime', '2026-10-13T05:45:00.000Z');
    expect(tables.calendar_blocks.eq).toHaveBeenCalledWith('site_id', SITE);
    expect(supabaseAdmin.from).not.toHaveBeenCalledWith('teams');
    expect(supabaseAdmin.from).not.toHaveBeenCalledWith('tasks');
  });

  it.each(['2026-10-09', '2026-10-10'])('rejects incident date %s before querying the database', async date => {
    await expect(getSchedulingAvailability({ ...input, date }, now)).rejects.toMatchObject({ code: 'DATE_IN_PAST' });
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it.each(['2026-02-30', '2026-2-03'])('rejects invalid date %s', async date => {
    await expect(getSchedulingAvailability({ ...input, date }, now)).rejects.toMatchObject({ code: 'INVALID_SCHEDULING_ARGUMENTS' });
  });

  it('accepts today in CDMX after UTC midnight but excludes elapsed slots', async () => {
    const result = await getSchedulingAvailability({ ...input, date: '2026-10-12' }, now);
    expect(result.success).toBe(true);
    expect(result.available_slots).toEqual([]);
  });

  it('does not replace an unknown or agent team_id with the default calendar', async () => {
    await expect(getSchedulingAvailability({ ...input, team_id: OTHER }, now)).rejects.toMatchObject({ code: 'CALENDAR_NOT_FOUND' });
    expect(supabaseAdmin.from).not.toHaveBeenCalledWith('appointments');
  });

  it('accepts a verified legacy team_id or personal user_id', async () => {
    expect((await getSchedulingAvailability({ ...input, team_id: CALENDAR }, now)).calendar_id).toBe(CALENDAR);
    expect((await getSchedulingAvailability({ ...input, user_id: USER }, now)).user_id).toBe(USER);
  });

  it('requires an explicit choice when more than one calendar exists', async () => {
    settings.calendars.push({ id: OTHER, member_ids: [USER] });
    await expect(getSchedulingAvailability(input, now)).rejects.toMatchObject({ code: 'CALENDAR_SELECTION_REQUIRED' });
  });

  it('never resolves an external email or participant outside the site/calendar', async () => {
    await expect(getSchedulingAvailability({ ...input, participants: [OTHER] }, now)).rejects.toMatchObject({ code: 'INVALID_PARTICIPANTS' });
    settings.calendars[0].member_ids = ['external@example.test'];
    await expect(getSchedulingAvailability(input, now)).rejects.toMatchObject({ code: 'CALENDAR_NOT_CONFIGURED' });
  });

  it('subtracts appointments, buffers, personal blocks and global blocks', async () => {
    tables.appointments = chain([{ start_datetime: '2026-10-13T16:00:00Z', end_datetime: '2026-10-13T17:00:00Z', participants: [USER] }]);
    tables.calendar_blocks = chain([
      { entity_type: 'user', entity_id: USER, start_time: '2026-10-13T19:00:00Z', end_time: '2026-10-13T20:00:00Z' },
      { entity_type: 'global', entity_id: null, start_time: '2026-10-13T21:00:00Z', end_time: '2026-10-13T23:00:00Z' },
    ]);
    const times = (await getSchedulingAvailability(input, now)).available_slots.map(slot => slot.start);
    expect(times).toEqual(['11:30', '14:00', '14:30']);
  });

  it('fails closed on unavailable occupancy or directory data', async () => {
    tables.appointments = chain(null, { message: 'private database error' });
    await expect(getSchedulingAvailability(input, now)).rejects.toMatchObject({ code: 'AVAILABILITY_UNAVAILABLE' });
    tables.settings = chain(null, { message: 'private database error' });
    await expect(getSchedulingAvailability(input, now)).rejects.toMatchObject({ code: 'CALENDAR_LOOKUP_FAILED' });
  });

  it('never invents working hours when neither member nor business has a schedule', async () => {
    delete profiles[0].settings.calendar.availability;
    settings.business_hours = null;
    await expect(getSchedulingAvailability(input, now)).rejects.toMatchObject({ code: 'CALENDAR_NOT_CONFIGURED' });
  });

  it('does not return a disabled member or treat missing working days as open', async () => {
    profiles[0].settings.calendar.enabled = false;
    expect((await getSchedulingAvailability(input, now)).available_slots).toEqual([]);
  });

  it('uses the configured hours timezone independently of the requested display timezone', async () => {
    const result = await getSchedulingAvailability({ ...input, timezone: 'UTC' }, now);
    expect(result.available_slots[0].start).toBe('16:00');
    expect(result.available_slots[0].start_utc).toBe('2026-10-13T16:00:00.000Z');
  });

  it('anchors slots to configured openings even when they are not on the hour or half hour', async () => {
    profiles[0].settings.calendar.availability.tuesday = { enabled: true, start: '10:15', end: '10:45' };
    const result = await getSchedulingAvailability(input, now);
    expect(result.available_slots.map(slot => slot.start)).toEqual(['10:15']);
  });

  it('excludes inactive membership before resolving calendar identities', async () => {
    tables.site_ownership = chain([]);
    tables.site_members = chain([{ user_id: USER, status: 'rejected' }]);
    await expect(getSchedulingAvailability(input, now)).rejects.toMatchObject({ code: 'CALENDAR_NOT_CONFIGURED' });
    expect(supabaseAdmin.from).not.toHaveBeenCalledWith('profiles');
  });

  it.each([
    { enabled: true, start: '02:00', end: '04:00' },
    { enabled: true, start: '01:00', end: '04:00', breaks: [{ start: '02:00', end: '03:00' }] },
  ])('rejects nonexistent DST-gap opening/break boundaries rather than inventing earlier slots', async day => {
    settings.business_hours = null;
    profiles[0].settings.calendar.timezone = 'America/New_York';
    profiles[0].settings.calendar.availability = { sunday: day };
    await expect(getSchedulingAvailability({ ...input, date: '2027-03-14', timezone: 'America/New_York' }, now))
      .rejects.toMatchObject({ code: 'CALENDAR_NOT_CONFIGURED' });
  });

  it('matches historical email participants case-insensitively like calendar member references', async () => {
    tables.appointments = chain([{ start_datetime: '2026-10-13T15:00:00Z', end_datetime: '2026-10-13T23:00:00Z', participants: [' MEMBER@example.test '] }]);
    expect((await getSchedulingAvailability(input, now)).available_slots).toEqual([]);
  });
});