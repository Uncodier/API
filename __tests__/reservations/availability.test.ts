import { getAvailableSlots, getBookedSeats, assertReservationSlot } from '../../src/lib/reservations/availability';
import { supabaseAdmin } from '../../src/lib/database/supabase-client';
import { addDays, setHours, startOfDay, addMinutes } from 'date-fns';

jest.mock('../../src/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('Reservations Availability Lib', () => {
  const mockDate = new Date('2026-07-27T10:00:00Z');
  const catalogItemId = 'cat-123';
  const siteId = 'site-123';

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
      gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data }),
      then: jest.fn((callback) => callback({ data })),
    };
    (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);
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

  describe('generateSlots & capacity', () => {
    it('generates slots based on days and duration', async () => {
      // Setup mock schedule (duration 60, capacity 2)
      // Monday 09:00-11:00 => 2 slots
      const scheduleData = {
        catalog_item_id: catalogItemId,
        site_id: siteId,
        duration_minutes: 60,
        capacity: 2,
        days: {
          ...getDayConfig(),
          monday: { enabled: true, start: '09:00', end: '11:00' },
        },
      };

      const q = mockQuery(scheduleData);
      
      // We also mock reservations returning an empty array for the second query
      q.gte.mockReturnValueOnce({
        lte: jest.fn().mockResolvedValue({ data: [] }),
      });

      const slots = await getAvailableSlots(catalogItemId, '2026-07-27T00:00:00Z', '2026-07-27T23:59:59Z', 1);
      
      expect(slots).toHaveLength(2);
      expect(slots[0].available).toBe(2);
      expect(new Date(slots[0].start).getHours()).toBe(9);
      expect(new Date(slots[1].start).getHours()).toBe(10);
    });

    it('reduces remaining seats for overlapping bookings', async () => {
      const scheduleData = {
        catalog_item_id: catalogItemId,
        site_id: siteId,
        duration_minutes: 60,
        capacity: 3,
        days: {
          ...getDayConfig(),
          monday: { enabled: true, start: '09:00', end: '10:00' },
        },
      };

      const q = mockQuery(scheduleData);
      
      // Mock one reservation consuming 2 seats for the 09:00-10:00 slot
      // 2026-07-27 is a Monday
      const d = startOfDay(mockDate);
      const startIso = setHours(d, 9).toISOString();
      const endIso = setHours(d, 10).toISOString();
      q.gte.mockReturnValueOnce({
        lte: jest.fn().mockResolvedValue({ 
          data: [{
            start_time: startIso,
            end_time: endIso,
            quantity: 2,
            status: 'confirmed'
          }]
        }),
      });

      const slots = await getAvailableSlots(catalogItemId, '2026-07-27T00:00:00Z', '2026-07-27T23:59:59Z', 1);
      
      expect(slots).toHaveLength(1);
      // capacity 3 - 2 booked = 1 available
      expect(slots[0].available).toBe(1);
    });
  });

  describe('assertReservationSlot', () => {
    it('fails when booking in the past for non-admin', async () => {
      mockQuery({
        site_id: siteId,
        days: getDayConfig()
      });
      
      await expect(assertReservationSlot(siteId, catalogItemId, '2026-07-26T09:00:00Z', '2026-07-26T10:00:00Z', 1))
        .rejects.toThrow('Cannot book in the past');
    });

    it('fails if outside hours', async () => {
      mockQuery({
        site_id: siteId,
        days: getDayConfig()
      });

      // Wednesday (enabled), but 08:00 is outside 09:00-17:00
      await expect(assertReservationSlot(siteId, catalogItemId, setHours(wednesdayLocal, 8).toISOString(), setHours(wednesdayLocal, 9).toISOString(), 1))
        .rejects.toThrow('Slot is outside of available schedule hours');
    });

    it('fails if disabled day', async () => {
      mockQuery({
        site_id: siteId,
        days: getDayConfig()
      });

      // Tuesday is disabled
      const tuesdayLocal = startOfDay(new Date('2026-07-28T12:00:00'));
      await expect(assertReservationSlot(siteId, catalogItemId, setHours(tuesdayLocal, 9).toISOString(), setHours(tuesdayLocal, 10).toISOString(), 1))
        .rejects.toThrow('Slot is outside of available schedule days');
    });

    const wednesdayLocal = startOfDay(new Date('2026-07-29T12:00:00')); // local timezone
    
    it('fails if quantity > remaining capacity', async () => {
      const q = mockQuery({
        site_id: siteId,
        capacity: 2,
        days: getDayConfig()
      });

      // Mock getBookedSeats query response
      q.gte.mockReturnValueOnce({
        lte: jest.fn().mockResolvedValue({ 
          data: [{
            quantity: 1,
            status: 'confirmed'
          }]
        }),
      });

      // Requesting 2 seats, but only 1 available (2 total - 1 booked)
      await expect(assertReservationSlot(siteId, catalogItemId, setHours(wednesdayLocal, 9).toISOString(), setHours(wednesdayLocal, 10).toISOString(), 2))
        .rejects.toThrow('Not enough capacity for this slot');
    });

    it('succeeds with valid slot and capacity', async () => {
      const q = mockQuery({
        site_id: siteId,
        capacity: 5,
        days: getDayConfig()
      });

      q.gte.mockReturnValueOnce({
        lte: jest.fn().mockResolvedValue({ 
          data: []
        }),
      });

      await expect(assertReservationSlot(siteId, catalogItemId, setHours(wednesdayLocal, 9).toISOString(), setHours(wednesdayLocal, 10).toISOString(), 1))
        .resolves.toBe(true);
    });
  });
});
