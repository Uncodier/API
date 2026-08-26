import { getAvailableSlots, assertReservationSlot, intervalsOverlap, ReservableCatalogItemError, resolveReservableCatalogItemId } from '../../src/lib/reservations/availability';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('Reservations Availability Lib', () => {
  const mockDate = new Date('2026-07-27T10:00:00Z');
  const catalogItemId = 'cat-123';
  const siteId = 'site-123';
  const CDMX = 'America/Mexico_City';

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

  const mockQuery = (data: any) => {
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data }),
      maybeSingle: jest.fn().mockResolvedValue({ data: null }),
      then: jest.fn((callback) => callback({ data: [] })),
    };
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'catalog_items') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: { id: catalogItemId, is_reservation: true },
          }),
        };
      }
      return chain;
    });
    return chain;
  };

  const getDayConfig = () => ({
    monday: { enabled: true, start: '09:00', end: '17:00' },
    tuesday: { enabled: false, start: '09:00', end: '17:00' },
    wednesday: { enabled: true, start: '09:00', end: '17:00' },
    thursday: { enabled: true, start: '09:00', end: '17:00' },
    friday: { enabled: true, start: '09:00', end: '17:00' },
    saturday: { enabled: false },
    sunday: { enabled: false },
  });

  const scheduleOf = (overrides: Record<string, unknown> = {}) => ({
    catalog_item_id: catalogItemId,
    site_id: siteId,
    timezone: CDMX,
    duration_minutes: 60,
    capacity: 1,
    days: getDayConfig(),
    ...overrides,
  });

  describe('intervalsOverlap', () => {
    it('treats back-to-back slots as free (half-open)', () => {
      const ten = new Date('2026-08-26T10:00:00Z');
      const eleven = new Date('2026-08-26T11:00:00Z');
      const twelve = new Date('2026-08-26T12:00:00Z');
      expect(intervalsOverlap(ten, eleven, eleven, twelve)).toBe(false);
      expect(intervalsOverlap(eleven, twelve, ten, eleven)).toBe(false);
    });

    it('detects exact and partial overlaps', () => {
      const ten = new Date('2026-08-26T10:00:00Z');
      const eleven = new Date('2026-08-26T11:00:00Z');
      const twelve = new Date('2026-08-26T12:00:00Z');
      expect(intervalsOverlap(ten, eleven, ten, eleven)).toBe(true);
      expect(intervalsOverlap(ten, twelve, eleven, twelve)).toBe(true);
    });
  });

  describe('generateSlots & capacity', () => {
    it('generates slots based on days and duration', async () => {
      const q = mockQuery(scheduleOf({
        capacity: 2,
        days: {
          ...getDayConfig(),
          monday: { enabled: true, start: '09:00', end: '11:00' },
        },
      }));

      q.lt.mockReturnValueOnce({
        gt: jest.fn().mockResolvedValue({ data: [] }),
      });

      const { slots, timezone } = await getAvailableSlots(catalogItemId, '2026-07-27', '2026-07-27', 1);

      expect(timezone).toBe(CDMX);
      expect(slots).toHaveLength(2);
      expect(slots[0].available).toBe(2);
      expect(slots[0].start).toBe('2026-07-27T15:00:00.000Z');
      expect(slots[0].start_local).toBe('09:00');
      expect(slots[1].start).toBe('2026-07-27T16:00:00.000Z');
      expect(slots[1].start_local).toBe('10:00');
    });

    it('serializes 12:00 CDMX as 18:00Z, not 12:00Z', async () => {
      const q = mockQuery(scheduleOf({
        days: {
          ...getDayConfig(),
          monday: { enabled: true, start: '12:00', end: '13:00' },
        },
      }));

      q.lt.mockReturnValueOnce({
        gt: jest.fn().mockResolvedValue({ data: [] }),
      });

      const { slots } = await getAvailableSlots(catalogItemId, '2026-07-27', '2026-07-27', 1);

      expect(slots).toHaveLength(1);
      expect(slots[0].start).toBe('2026-07-27T18:00:00.000Z');
      expect(slots[0].end).toBe('2026-07-27T19:00:00.000Z');
      expect(slots[0].start_local).toBe('12:00');
      expect(slots[0].timezone).toBe(CDMX);
      expect(slots[0].start).not.toBe('2026-07-27T12:00:00.000Z');
    });

    it('skips slots that overlap a lunch break', async () => {
      const q = mockQuery(scheduleOf({
        days: {
          ...getDayConfig(),
          monday: {
            enabled: true,
            start: '11:00',
            end: '14:00',
            breaks: [{ start: '12:00', end: '13:00' }],
          },
        },
      }));

      q.lt.mockReturnValueOnce({
        gt: jest.fn().mockResolvedValue({ data: [] }),
      });

      const { slots } = await getAvailableSlots(catalogItemId, '2026-07-27', '2026-07-27', 1);
      expect(slots.map((slot) => slot.start)).toEqual([
        '2026-07-27T17:00:00.000Z',
        '2026-07-27T19:00:00.000Z',
      ]);
      expect(slots.map((slot) => slot.start_local)).toEqual(['11:00', '13:00']);
    });

    it('reduces remaining seats for overlapping bookings', async () => {
      const q = mockQuery(scheduleOf({
        capacity: 3,
        days: {
          ...getDayConfig(),
          monday: { enabled: true, start: '09:00', end: '10:00' },
        },
      }));

      q.lt.mockReturnValueOnce({
        gt: jest.fn().mockResolvedValue({
          data: [{
            start_time: '2026-07-27T15:00:00.000Z',
            end_time: '2026-07-27T16:00:00.000Z',
            quantity: 2,
            status: 'confirmed'
          }]
        }),
      });

      const { slots } = await getAvailableSlots(catalogItemId, '2026-07-27', '2026-07-27', 1);

      expect(slots).toHaveLength(1);
      expect(slots[0].available).toBe(1);
    });

    it('keeps a slot available when the only booking is adjacent', async () => {
      const q = mockQuery(scheduleOf({
        days: {
          ...getDayConfig(),
          monday: { enabled: true, start: '09:00', end: '11:00' },
        },
      }));

      q.lt.mockReturnValueOnce({
        gt: jest.fn().mockResolvedValue({
          data: [{
            start_time: '2026-07-27T15:00:00.000Z',
            end_time: '2026-07-27T16:00:00.000Z',
            quantity: 1,
            status: 'pending',
          }],
        }),
      });

      const { slots } = await getAvailableSlots(catalogItemId, '2026-07-27', '2026-07-27', 1);
      expect(slots).toHaveLength(1);
      expect(slots[0].start).toBe('2026-07-27T16:00:00.000Z');
      expect(slots[0].start_local).toBe('10:00');
      expect(slots[0].available).toBe(1);
    });

    it('returns no slots when the item and schedule are valid but the day is closed', async () => {
      const q = mockQuery(scheduleOf({
        days: {
          ...getDayConfig(),
          monday: { enabled: false },
        },
      }));

      q.lt.mockReturnValueOnce({
        gt: jest.fn().mockResolvedValue({ data: [] }),
      });

      const { slots } = await getAvailableSlots(catalogItemId, '2026-07-27', '2026-07-27', 1);
      expect(slots).toEqual([]);
    });
  });

  describe('resolveReservableCatalogItemId', () => {
    it('fails a reservation folio so the model can retry with catalog_item_id', async () => {
      (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'catalog_items') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: null }),
          };
        }
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: { id: '1aea4bd8-folio', catalog_item_id: '54040381-emmanuel' },
          }),
        };
      });

      await expect(resolveReservableCatalogItemId('1aea4bd8-folio')).rejects.toThrow(ReservableCatalogItemError);
      await expect(resolveReservableCatalogItemId('1aea4bd8-folio')).rejects.toThrow(
        'use catalog_item_id=54040381-emmanuel'
      );
    });

    it('rejects an unknown UUID', async () => {
      (supabaseAdmin.from as jest.Mock).mockImplementation(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null }),
      }));

      await expect(resolveReservableCatalogItemId('missing-id')).rejects.toThrow('catalog item not found: missing-id');
    });

    it('fails getAvailableSlots when the item has no schedule', async () => {
      mockQuery(null);
      await expect(
        getAvailableSlots(catalogItemId, '2026-07-27', '2026-07-27', 1)
      ).rejects.toThrow('no schedule configured');
    });
  });

  describe('assertReservationSlot', () => {
    it('fails when booking in the past for non-admin', async () => {
      mockQuery(scheduleOf());

      await expect(assertReservationSlot(siteId, catalogItemId, '2026-07-26T15:00:00.000Z', '2026-07-26T16:00:00.000Z', 1))
        .rejects.toThrow('Cannot book in the past');
    });

    it('fails if outside hours', async () => {
      mockQuery(scheduleOf());

      await expect(assertReservationSlot(siteId, catalogItemId, '2026-07-29T14:00:00.000Z', '2026-07-29T15:00:00.000Z', 1))
        .rejects.toThrow('Slot is outside of available schedule hours');
    });

    it('fails if disabled day', async () => {
      mockQuery(scheduleOf());

      await expect(assertReservationSlot(siteId, catalogItemId, '2026-07-28T15:00:00.000Z', '2026-07-28T16:00:00.000Z', 1))
        .rejects.toThrow('Slot is outside of available schedule days');
    });

    it('fails if quantity > remaining capacity', async () => {
      const q = mockQuery(scheduleOf({ capacity: 2 }));

      q.gt.mockReturnValueOnce({
        lt: jest.fn().mockResolvedValue({
          data: [{
            quantity: 1,
            status: 'confirmed'
          }]
        }),
      });

      await expect(assertReservationSlot(siteId, catalogItemId, '2026-07-29T15:00:00.000Z', '2026-07-29T16:00:00.000Z', 2))
        .rejects.toThrow('Not enough capacity for this slot');
    });

    it('succeeds with valid slot and capacity', async () => {
      const q = mockQuery(scheduleOf({ capacity: 5 }));

      q.gt.mockReturnValueOnce({
        lt: jest.fn().mockResolvedValue({
          data: []
        }),
      });

      await expect(assertReservationSlot(siteId, catalogItemId, '2026-07-29T15:00:00.000Z', '2026-07-29T16:00:00.000Z', 1))
        .resolves.toEqual({
          start_utc: '2026-07-29T15:00:00.000Z',
          end_utc: '2026-07-29T16:00:00.000Z',
        });
    });

    it('treats naive 12:00 as CDMX wall-clock and stores 18:00Z', async () => {
      const q = mockQuery(scheduleOf({ capacity: 5 }));

      q.gt.mockReturnValueOnce({
        lt: jest.fn().mockResolvedValue({
          data: []
        }),
      });

      await expect(assertReservationSlot(siteId, catalogItemId, '2026-07-29T12:00:00', '2026-07-29T13:00:00', 1))
        .resolves.toEqual({
          start_utc: '2026-07-29T18:00:00.000Z',
          end_utc: '2026-07-29T19:00:00.000Z',
        });
    });

    it('queries booked seats with exclusive overlap bounds', async () => {
      const q = mockQuery(scheduleOf());

      const lt = jest.fn().mockResolvedValue({ data: [] });
      q.gt.mockReturnValueOnce({ lt });

      const startIso = '2026-07-29T19:00:00.000Z';
      const endIso = '2026-07-29T20:00:00.000Z';
      await assertReservationSlot(siteId, catalogItemId, startIso, endIso, 1);

      expect(q.gt).toHaveBeenCalledWith('end_time', startIso);
      expect(lt).toHaveBeenCalledWith('start_time', endIso);
    });
  });
});
