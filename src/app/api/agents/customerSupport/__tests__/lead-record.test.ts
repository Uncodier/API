import { formatLeadRecordForContext, type LeadRecordSnapshot } from '../lead-record';

describe('formatLeadRecordForContext', () => {
  it('tells the agent to look up tools when the snapshot is empty', () => {
    const empty: LeadRecordSnapshot = {
      appointments: [],
      reservations: [],
      meetingTasks: [],
      orders: [],
    };

    const text = formatLeadRecordForContext(empty, 'America/Mexico_City');

    expect(text).toContain('=== LEAD RECORD (source of truth) ===');
    expect(text).toContain('No active appointments');
    expect(text).toContain('Still look them up with tools');
  });

  it('lists existing appointments so a later turn cannot miss the 11:00 booking', () => {
    const snapshot: LeadRecordSnapshot = {
      appointments: [
        {
          id: 'appt-11',
          title: 'Mauricio',
          start_datetime: '2026-08-26T17:00:00.000Z',
          end_datetime: '2026-08-26T18:00:00.000Z',
          status: 'confirmed',
          timezone: 'America/Mexico_City',
        },
      ],
      reservations: [],
      meetingTasks: [],
      orders: [{ id: 'ord-1', title: 'Order - 2026-08-26', status: 'pending', amount: 500, currency: 'MXN' }],
    };

    const text = formatLeadRecordForContext(snapshot, 'America/Mexico_City');

    expect(text).toContain('id=appt-11');
    expect(text).toContain('Mauricio');
    expect(text).toContain('2026-08-26 11:00 America/Mexico_City');
    expect(text).toContain('start_utc=2026-08-26T17:00:00.000Z');
    expect(text).toContain('id=ord-1');
    expect(text).toContain('reschedule/update that record');
    expect(text).not.toContain('No active appointments');
  });
});
