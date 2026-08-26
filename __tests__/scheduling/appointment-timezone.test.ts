import {
  appointmentListUtcRange,
  appointmentPublicFields,
  type AppointmentRow,
} from '../../src/lib/scheduling/appointments';

const MX = 'America/Mexico_City';

describe('scheduling appointment timezones', () => {
  it('lists a local calendar day with Mexico midnight UTC bounds, not UTC midnight', () => {
    const range = appointmentListUtcRange('2026-08-26', MX);
    expect(range.start_utc).toBe('2026-08-26T06:00:00.000Z');
    expect(range.end_utc).toBe('2026-08-27T06:00:00.000Z');

    const sevenPmCdmx = '2026-08-27T01:00:00.000Z';
    expect(sevenPmCdmx >= range.start_utc && sevenPmCdmx < range.end_utc).toBe(true);

    const utcMidnightSliceEnd = '2026-08-27T00:00:00.000Z';
    expect(sevenPmCdmx >= utcMidnightSliceEnd).toBe(true);
  });

  it('exposes local wall-clock 11:00 CDMX alongside 17:00Z for mutations', () => {
    const appointment = {
      id: 'appt-11',
      title: 'Mauricio',
      start_datetime: '2026-08-26T17:00:00.000Z',
      end_datetime: '2026-08-26T18:00:00.000Z',
      duration: 60,
      timezone: MX,
      context_id: 'lead-1',
      site_id: 'site-1',
      status: 'confirmed',
    } as AppointmentRow;

    const pub = appointmentPublicFields(appointment);
    expect(pub.start).toBe('11:00');
    expect(pub.end).toBe('12:00');
    expect(pub.local_start).toBe('2026-08-26 11:00');
    expect(pub.start_utc).toBe('2026-08-26T17:00:00.000Z');
    expect(pub.timezone).toBe(MX);
  });
});
