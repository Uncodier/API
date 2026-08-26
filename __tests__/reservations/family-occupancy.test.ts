import { getAvailableSlots, assertReservationSlot } from '../../src/lib/reservations/availability';
import {
  availableSeatsForSlot,
  countBookedSeats,
  countRoundRobinAvailable,
} from '../../src/lib/reservations/family-occupancy';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('family occupancy helpers', () => {
  const start = new Date('2026-07-27T15:00:00.000Z');
  const end = new Date('2026-07-27T16:00:00.000Z');

  it('counts overlapping seats only inside the requested family', () => {
    const booked = countBookedSeats(
      [
        { catalog_item_id: 'barba', start_time: start.toISOString(), end_time: end.toISOString(), quantity: 1 },
        { catalog_item_id: 'other', start_time: start.toISOString(), end_time: end.toISOString(), quantity: 1 },
      ],
      start,
      end,
      ['corte', 'barba', 'emmanuel']
    );
    expect(booked).toBe(1);
  });

  it('treats a parent-family booking as blocking user_choice capacity', () => {
    const seats = availableSeatsForSlot(
      {
        family: {
          catalogItemId: 'corte',
          rootId: 'emmanuel',
          familyIds: ['emmanuel', 'corte', 'barba'],
          mode: 'user_choice',
          siteId: 'site-1',
        },
        reservations: [{
          catalog_item_id: 'barba',
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          quantity: 1,
        }],
        calendarBlocks: [],
        peers: [],
        peerReservations: [],
      },
      start,
      end,
      1
    );
    expect(seats).toEqual({ available: 0, isBlocked: false });
  });

  it('does not let a sibling booking on another barber consume this family', () => {
    const seats = availableSeatsForSlot(
      {
        family: {
          catalogItemId: 'corte',
          rootId: 'emmanuel',
          familyIds: ['emmanuel', 'corte', 'barba'],
          mode: 'user_choice',
          siteId: 'site-1',
        },
        reservations: [{
          catalog_item_id: 'mauricio-corte',
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          quantity: 1,
        }],
        calendarBlocks: [],
        peers: [],
        peerReservations: [],
      },
      start,
      end,
      1
    );
    expect(seats).toEqual({ available: 1, isBlocked: false });
  });

  it('applies a parent calendar block to the variant', () => {
    const seats = availableSeatsForSlot(
      {
        family: {
          catalogItemId: 'corte',
          rootId: 'emmanuel',
          familyIds: ['emmanuel', 'corte', 'barba'],
          mode: 'user_choice',
          siteId: 'site-1',
        },
        reservations: [],
        calendarBlocks: [{
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          entity_type: 'catalog_item',
          entity_id: 'emmanuel',
        }],
        peers: [],
        peerReservations: [],
      },
      start,
      end,
      1
    );
    expect(seats).toEqual({ available: 0, isBlocked: true });
  });

  it('counts free round_robin peers and subtracts anonymous any-barber bookings', () => {
    const available = countRoundRobinAvailable(
      [
        { rootId: 'emmanuel', familyIds: ['emmanuel', 'corte'], capacity: 1 },
        { rootId: 'mauricio', familyIds: ['mauricio', 'mau-corte'], capacity: 1 },
      ],
      [{
        catalog_item_id: 'mau-corte',
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        quantity: 1,
      }],
      [{
        catalog_item_id: 'any-corte',
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        quantity: 1,
      }],
      ['any-corte', 'any-parent'],
      [],
      start,
      end
    );
    expect(available).toBe(0);
  });
});

describe('family occupancy via getAvailableSlots', () => {
  const mockDate = new Date('2026-07-27T10:00:00Z');
  const siteId = 'site-123';
  const CDMX = 'America/Mexico_City';
  const emmanuel = 'parent-emmanuel';
  const corte = 'var-corte';
  const barba = 'var-barba';
  const mauricio = 'parent-mauricio';
  const anyParent = 'parent-any';
  const anyCorte = 'var-any-corte';

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(mockDate);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const mondayHours = {
    monday: { enabled: true, start: '09:00', end: '11:00' },
    tuesday: { enabled: false },
    wednesday: { enabled: false },
    thursday: { enabled: false },
    friday: { enabled: false },
    saturday: { enabled: false },
    sunday: { enabled: false },
  };

  const item = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    is_reservation: true,
    parent_id: null,
    site_id: siteId,
    redeem_assignment_mode: 'user_choice',
    ...overrides,
  });

  const familyItems = [
    item(emmanuel),
    item(corte, { parent_id: emmanuel }),
    item(barba, { parent_id: emmanuel }),
    item(mauricio),
    item(anyParent, { redeem_assignment_mode: 'round_robin' }),
    item(anyCorte, { parent_id: anyParent, redeem_assignment_mode: 'round_robin' }),
  ];

  function mockWorld(opts: {
    queriedId: string;
    reservations?: any[];
    blocks?: any[];
    scheduleOverrides?: Record<string, unknown>;
  }) {
    const schedule = {
      catalog_item_id: opts.queriedId,
      site_id: siteId,
      timezone: CDMX,
      duration_minutes: 60,
      capacity: 1,
      days: mondayHours,
      ...opts.scheduleOverrides,
    };
    const reservations = opts.reservations || [];
    const blocks = opts.blocks || [];

    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'catalog_items') {
        const state: { id?: string; parentId?: string; bySite?: boolean } = {};
        const api: any = {
          select: () => api,
          eq: (col: string, val: string) => {
            if (col === 'id') state.id = val;
            if (col === 'parent_id') state.parentId = val;
            if (col === 'site_id') state.bySite = true;
            return api;
          },
          in: () => api,
          is: () => api,
          maybeSingle: async () => ({
            data: familyItems.find((row) => row.id === state.id) || null,
          }),
          then: (resolve: (value: unknown) => unknown) => {
            if (state.parentId) {
              return Promise.resolve(resolve({
                data: familyItems.filter((row) => row.parent_id === state.parentId),
              }));
            }
            if (state.bySite) {
              return Promise.resolve(resolve({ data: familyItems }));
            }
            return Promise.resolve(resolve({ data: [] }));
          },
        };
        return api;
      }

      if (table === 'reservation_schedules') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          in: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: schedule }),
          then: (resolve: (value: unknown) => unknown) => resolve({
            data: [
              { catalog_item_id: emmanuel, capacity: 1 },
              { catalog_item_id: mauricio, capacity: 1 },
            ],
          }),
        };
      }

      if (table === 'reservations') {
        return {
          select: jest.fn().mockReturnThis(),
          in: jest.fn().mockReturnThis(),
          lt: jest.fn().mockReturnValue({
            gt: jest.fn().mockResolvedValue({ data: reservations }),
          }),
          neq: jest.fn().mockResolvedValue({ data: reservations }),
        };
      }

      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        lte: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: blocks }),
      };
    });
  }

  it('reduces Corte slots when Barba on the same barber is booked', async () => {
    mockWorld({
      queriedId: corte,
      reservations: [{
        catalog_item_id: barba,
        start_time: '2026-07-27T15:00:00.000Z',
        end_time: '2026-07-27T16:00:00.000Z',
        quantity: 1,
        status: 'confirmed',
      }],
    });

    const { slots } = await getAvailableSlots(corte, '2026-07-27', '2026-07-27', 1);
    expect(slots.map((slot) => slot.start_local)).toEqual(['10:00']);
  });

  it('reduces a variant when the parent barber is booked', async () => {
    mockWorld({
      queriedId: corte,
      reservations: [{
        catalog_item_id: emmanuel,
        start_time: '2026-07-27T15:00:00.000Z',
        end_time: '2026-07-27T16:00:00.000Z',
        quantity: 1,
        status: 'pending',
      }],
    });

    const { slots } = await getAvailableSlots(corte, '2026-07-27', '2026-07-27', 1);
    expect(slots.map((slot) => slot.start_local)).toEqual(['10:00']);
  });

  it('keeps Emmanuel free when another barber is booked', async () => {
    mockWorld({
      queriedId: corte,
      reservations: [{
        catalog_item_id: mauricio,
        start_time: '2026-07-27T15:00:00.000Z',
        end_time: '2026-07-27T16:00:00.000Z',
        quantity: 1,
        status: 'confirmed',
      }],
    });

    const { slots } = await getAvailableSlots(corte, '2026-07-27', '2026-07-27', 1);
    expect(slots.map((slot) => slot.start_local)).toEqual(['09:00', '10:00']);
  });

  it('hides a variant slot when the parent has a calendar block', async () => {
    mockWorld({
      queriedId: corte,
      blocks: [{
        start_time: '2026-07-27T15:00:00.000Z',
        end_time: '2026-07-27T16:00:00.000Z',
        entity_type: 'catalog_item',
        entity_id: emmanuel,
      }],
    });

    const { slots } = await getAvailableSlots(corte, '2026-07-27', '2026-07-27', 1);
    expect(slots.map((slot) => slot.start_local)).toEqual(['10:00']);
  });

  it('offers a round_robin slot when at least one named barber is free', async () => {
    mockWorld({
      queriedId: anyCorte,
      reservations: [{
        catalog_item_id: mauricio,
        start_time: '2026-07-27T15:00:00.000Z',
        end_time: '2026-07-27T16:00:00.000Z',
        quantity: 1,
        status: 'confirmed',
      }],
    });

    const { slots } = await getAvailableSlots(anyCorte, '2026-07-27', '2026-07-27', 1);
    expect(slots).toHaveLength(2);
    expect(slots[0].available).toBe(1);
    expect(slots[1].available).toBe(2);
  });

  it('hides a round_robin slot when every named barber is booked', async () => {
    mockWorld({
      queriedId: anyCorte,
      reservations: [
        {
          catalog_item_id: emmanuel,
          start_time: '2026-07-27T15:00:00.000Z',
          end_time: '2026-07-27T16:00:00.000Z',
          quantity: 1,
          status: 'confirmed',
        },
        {
          catalog_item_id: mauricio,
          start_time: '2026-07-27T15:00:00.000Z',
          end_time: '2026-07-27T16:00:00.000Z',
          quantity: 1,
          status: 'confirmed',
        },
      ],
    });

    const { slots } = await getAvailableSlots(anyCorte, '2026-07-27', '2026-07-27', 1);
    expect(slots.map((slot) => slot.start_local)).toEqual(['10:00']);
    await expect(
      assertReservationSlot(siteId, anyCorte, '2026-07-27T15:00:00.000Z', '2026-07-27T16:00:00.000Z', 1, true)
    ).rejects.toThrow('Not enough capacity for this slot');
  });
});
