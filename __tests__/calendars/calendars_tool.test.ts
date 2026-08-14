import { calendarsCore } from '../../src/app/api/agents/tools/calendars/core';
import { normalizeWeeklyAvailability } from '../../src/lib/reservations/weekly-hours';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

function makeChain(result: { data?: unknown; error?: { message: string } | null }) {
  const payload = { data: result.data ?? null, error: result.error ?? null };
  const chain: any = {};
  for (const method of ['select', 'eq', 'in', 'update', 'insert', 'upsert', 'order', 'range']) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(payload);
  chain.maybeSingle = jest.fn().mockResolvedValue(payload);
  chain.then = (onFulfilled: any, onRejected: any) => Promise.resolve(payload).then(onFulfilled, onRejected);
  return chain;
}

describe('calendars tool', () => {
  const siteId = 'site-123';
  const mauricioId = 'user-mauricio';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes lunch breaks and 24h times', () => {
    const days = normalizeWeeklyAvailability({
      monday: { enabled: true, start: '11:00', end: '20:00', breaks: [{ start: '15:00', end: '16:00' }] },
      saturday: { enabled: true, start: '11', end: '16:00' },
    });

    expect(days.monday).toEqual({
      enabled: true,
      start: '11:00',
      end: '20:00',
      breaks: [{ start: '15:00', end: '16:00' }],
    });
    expect(days.saturday?.start).toBe('11:00');
    expect(days.sunday).toEqual({ enabled: false });
  });

  it('lists team members, team calendars, and reservable services', async () => {
    const chains: Record<string, any> = {
      site_ownership: makeChain({ data: [{ user_id: mauricioId }] }),
      site_members: makeChain({ data: [] }),
      profiles: makeChain({
        data: [
          {
            id: mauricioId,
            name: 'Mauricio',
            email: 'mauricio@example.com',
            settings: {
              calendar: {
                enabled: true,
                timezone: 'America/Mexico_City',
                availability: { monday: { enabled: true, start: '09:00', end: '18:00' } },
              },
            },
          },
        ],
      }),
      settings: makeChain({
        data: {
          id: 'settings-1',
          calendars: [{ id: 'cal-rr', name: 'Sales RR', member_ids: [mauricioId] }],
          business_hours: { monday: { start: '11:00', end: '20:00' } },
        },
      }),
      catalog_items: makeChain({
        data: [{ id: 'svc-1', name: 'Corte', kind: 'service', is_reservation: true, status: 'active' }],
      }),
      reservation_schedules: makeChain({
        data: [{ id: 'sch-1', catalog_item_id: 'svc-1', days: { monday: { enabled: true, start: '11:00', end: '20:00' } } }],
      }),
    };

    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => chains[table] || makeChain({ data: [] }));

    const result: any = await calendarsCore({ action: 'list', site_id: siteId, query: 'Mauricio' });

    expect(result.success).toBe(true);
    expect(result.team_members).toHaveLength(1);
    expect(result.team_members[0].name).toBe('Mauricio');
    expect(result.team_members[0].calendar.timezone).toBe('America/Mexico_City');
    expect(result.team_calendars[0].name).toBe('Sales RR');
    expect(result.reservable_services[0].name).toBe('Corte');
    expect(result.business_hours.monday.start).toBe('11:00');
  });

  it('updates a member calendar by name with lunch break', async () => {
    const listProfiles = makeChain({
      data: [{ id: mauricioId, name: 'Mauricio', email: 'mauricio@example.com', settings: {} }],
    });
    const owners = makeChain({ data: [{ user_id: mauricioId }] });
    const members = makeChain({ data: [] });
    const profileGet = makeChain({ data: { id: mauricioId, settings: { locale: 'es' } } });
    const profileUpdate = makeChain({
      data: {
        id: mauricioId,
        name: 'Mauricio',
        email: 'mauricio@example.com',
        settings: {
          locale: 'es',
          calendar: {
            enabled: true,
            timezone: 'America/Mexico_City',
            availability: {
              monday: { enabled: true, start: '11:00', end: '20:00', breaks: [{ start: '15:00', end: '16:00' }] },
            },
          },
        },
      },
    });

    let profileCalls = 0;
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'site_ownership') return owners;
      if (table === 'site_members') return members;
      if (table === 'profiles') {
        profileCalls += 1;
        if (profileCalls === 1) return listProfiles;
        if (profileCalls === 2) return profileGet;
        return profileUpdate;
      }
      return makeChain({ data: [] });
    });

    const result: any = await calendarsCore({
      action: 'update_member_calendar',
      site_id: siteId,
      query: 'Mauricio',
      timezone: 'America/Mexico_City',
      availability: {
        monday: { enabled: true, start: '11:00', end: '20:00', breaks: [{ start: '15:00', end: '16:00' }] },
        tuesday: { enabled: true, start: '11:00', end: '20:00', breaks: [{ start: '15:00', end: '16:00' }] },
        wednesday: { enabled: true, start: '11:00', end: '20:00', breaks: [{ start: '15:00', end: '16:00' }] },
        thursday: { enabled: true, start: '11:00', end: '20:00', breaks: [{ start: '15:00', end: '16:00' }] },
        friday: { enabled: true, start: '11:00', end: '20:00', breaks: [{ start: '15:00', end: '16:00' }] },
        saturday: { enabled: true, start: '11:00', end: '16:00' },
        sunday: { enabled: false },
      },
    });

    expect(result.success).toBe(true);
    expect(result.team_member.user_id).toBe(mauricioId);
    expect(profileUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          locale: 'es',
          calendar: expect.objectContaining({
            timezone: 'America/Mexico_City',
            availability: expect.objectContaining({
              monday: expect.objectContaining({
                start: '11:00',
                end: '20:00',
                breaks: [{ start: '15:00', end: '16:00' }],
              }),
              saturday: expect.objectContaining({ start: '11:00', end: '16:00' }),
              sunday: { enabled: false },
            }),
          }),
        }),
      })
    );
  });
});
