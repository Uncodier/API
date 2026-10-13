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

  it('removes every busy participant without splice-skipping and never returns an empty team', () => {
    const slots = generateAvailableSlots('2026-10-13', '09:00', '10:00', 30,
      [{ start_datetime: '2026-10-13T14:00:00Z', end_datetime: '2026-10-13T17:00:00Z', participants: ['u1', 'u2'] }],
      [], [], [{ id: 'u1' }, { id: 'u2' }], CDMX);
    expect(slots).toEqual([]);
    expect(generateAvailableSlots('2026-10-13', '09:00', '10:00', 30, [], [], [], [], CDMX)).toEqual([]);
  });

  it('returns one free team member for round-robin but not when a requested participant is busy', () => {
    const meetings = [{ start_datetime: '2026-10-13T15:00:00Z', end_datetime: '2026-10-13T16:00:00Z', participants: ['u1'] }];
    const members = [{ id: 'u1' }, { id: 'u2' }];
    const slots = generateAvailableSlots('2026-10-13', '09:00', '10:00', 30, meetings, [], [], members, CDMX);
    expect(slots).toHaveLength(2);
    expect(slots[0].available_participants).toEqual([{ id: 'u2' }]);
    expect(generateAvailableSlots('2026-10-13', '09:00', '10:00', 30, meetings, ['u1'], [], members, CDMX)).toEqual([]);
  });

  it('permits adjacent intervals, blocks enclosing ones, and filters elapsed starts', () => {
    const meetings = [{ start_datetime: '2026-10-13T14:00:00Z', end_datetime: '2026-10-13T15:00:00Z', participants: ['u1'] }];
    const slots = generateAvailableSlots('2026-10-13', '09:00', '10:00', 30, meetings, [], [], [{ id: 'u1' }], CDMX,
      { now: new Date('2026-10-13T15:00:00Z') });
    expect(slots.map(slot => slot.start)).toEqual(['09:30']);
  });
});
