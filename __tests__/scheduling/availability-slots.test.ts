import { generateAvailableSlots } from '../../src/lib/scheduling/availability-slots';

describe('scheduling availability slots', () => {
  const CDMX = 'America/Mexico_City';

  it('serializes 12:00 CDMX as 18:00Z, not 12:00Z', () => {
    const slots = generateAvailableSlots(
      '2026-07-27',
      '12:00',
      '13:00',
      60,
      [],
      [],
      [],
      [{ id: 'u1', name: 'Alex', role: 'owner' }],
      CDMX
    );

    expect(slots).toHaveLength(1);
    expect(slots[0].start).toBe('12:00');
    expect(slots[0].start_utc).toBe('2026-07-27T18:00:00.000Z');
    expect(slots[0].end_utc).toBe('2026-07-27T19:00:00.000Z');
    expect(slots[0].start_utc).not.toBe('2026-07-27T12:00:00.000Z');
  });

  it('emits 09:00 CDMX as 15:00Z', () => {
    const slots = generateAvailableSlots(
      '2026-07-27',
      '09:00',
      '10:00',
      60,
      [],
      [],
      [],
      [{ id: 'u1', name: 'Alex', role: 'owner' }],
      CDMX
    );

    expect(slots[0].start_utc).toBe('2026-07-27T15:00:00.000Z');
    expect(slots[0].start).toBe('09:00');
  });
});
