import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/agents/tools/scheduling/schedule/route';
import {
  listAppointments,
  updateAppointment,
  createAppointment,
} from '../../src/lib/scheduling/appointments';

jest.mock('../../src/lib/scheduling/appointments', () => ({
  listAppointments: jest.fn(),
  updateAppointment: jest.fn(),
  createAppointment: jest.fn(),
  appointmentPublicFields: (appointment: any) => ({
    appointment_id: appointment.id,
    title: appointment.title,
    start_datetime: appointment.start_datetime,
    end_datetime: appointment.end_datetime,
    timezone: appointment.timezone,
    status: appointment.status,
    calendar_link: appointment.calendar_link,
    context_id: appointment.context_id,
    duration: appointment.duration,
    participants: appointment.participants,
  }),
}));

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest('http://localhost/api/agents/tools/scheduling/schedule', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

describe('scheduling schedule route list/update', () => {
  const siteId = '11111111-1111-4111-8111-111111111111';
  const leadId = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists appointments for a lead via action=list', async () => {
    (listAppointments as jest.Mock).mockResolvedValue([
      {
        id: 'appt-11',
        title: 'Mauricio',
        start_datetime: '2026-08-26T17:00:00.000Z',
        end_datetime: '2026-08-26T18:00:00.000Z',
        timezone: 'America/Mexico_City',
        status: 'confirmed',
        context_id: leadId,
        duration: 60,
      },
    ]);

    const res = await post({
      action: 'list',
      site_id: siteId,
      lead_id: leadId,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.appointments).toHaveLength(1);
    expect(json.appointments[0].appointment_id).toBe('appt-11');
    expect(listAppointments).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: siteId, context_id: leadId })
    );
  });

  it('passes local date + timezone through to list so 7pm CDMX is not dropped', async () => {
    (listAppointments as jest.Mock).mockResolvedValue([]);

    await post({
      action: 'list',
      site_id: siteId,
      lead_id: leadId,
      date: '2026-08-26',
      timezone: 'America/Mexico_City',
    });

    expect(listAppointments).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-08-26',
        timezone: 'America/Mexico_City',
        context_id: leadId,
      })
    );
  });

  it('updates an existing appointment instead of creating a duplicate', async () => {
    (updateAppointment as jest.Mock).mockResolvedValue({
      id: 'appt-11',
      title: 'Mauricio',
      start_datetime: '2026-08-26T22:00:00.000Z',
      end_datetime: '2026-08-26T23:00:00.000Z',
      timezone: 'America/Mexico_City',
      status: 'confirmed',
      context_id: leadId,
      duration: 60,
    });

    const res = await post({
      action: 'update',
      site_id: siteId,
      appointment_id: 'appt-11',
      start_datetime: '2026-08-26T22:00:00.000Z',
      duration: 60,
      timezone: 'America/Mexico_City',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.appointment_id).toBe('appt-11');
    expect(json.start_datetime).toBe('2026-08-26T22:00:00.000Z');
    expect(updateAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ appointment_id: 'appt-11', site_id: siteId })
    );
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it('rejects update without appointment_id', async () => {
    const res = await post({
      action: 'update',
      site_id: siteId,
      start_datetime: '2026-08-26T22:00:00.000Z',
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(updateAppointment).not.toHaveBeenCalled();
  });
});
