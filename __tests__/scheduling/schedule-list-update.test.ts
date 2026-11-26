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

import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';
jest.mock('@/lib/security/tool-request-principal', () => ({
  resolveToolRequestPrincipal: jest.fn(), canToolPrincipalAccessSite: jest.fn(),
}));

function post(body: Record<string, unknown>, headers?: Record<string, string>) {
  return POST(
    new NextRequest('http://localhost/api/agents/tools/scheduling/schedule', {
      method: 'POST', headers,
      body: JSON.stringify(body),
    })
  );
}

describe('scheduling schedule route list/update', () => {
  const siteId = '11111111-1111-4111-8111-111111111111';
  const leadId = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    jest.clearAllMocks();
    (resolveToolRequestPrincipal as jest.Mock).mockResolvedValue({ internal: true });
    (canToolPrincipalAccessSite as jest.Mock).mockResolvedValue(true);
  });

  const create = { site_id: siteId, context_id: leadId, title: 'Meeting', start_datetime: '2099-02-01T15:00:00Z',
    duration: 30, timezone: 'UTC' };
  const turn = '33333333-3333-4333-8333-333333333333';
  it('requires a credential and site access before create/replay', async () => {
    (resolveToolRequestPrincipal as jest.Mock).mockResolvedValueOnce(null);
    expect((await post(create)).status).toBe(401);
    (canToolPrincipalAccessSite as jest.Mock).mockResolvedValueOnce(false);
    expect((await post(create)).status).toBe(403);
    (resolveToolRequestPrincipal as jest.Mock).mockResolvedValueOnce({ internal: false });
    expect((await post(create, { 'x-native-scheduling-turn': turn })).status).toBe(403);
    expect(createAppointment).not.toHaveBeenCalled();
  });
  it('ignores body-supplied operation identity and distinguishes a verified replay from creation', async () => {
    const appointment = { id: 'existing', status: 'cancelled' };
    (createAppointment as jest.Mock).mockResolvedValueOnce({ appointment, replayed: false })
      .mockResolvedValueOnce({ appointment, replayed: true });
    expect((await post({ ...create, turn, id: turn })).status).toBe(201);
    expect(createAppointment).toHaveBeenLastCalledWith(expect.not.objectContaining({ turn }), undefined);
    const response = await post(create, { 'x-native-scheduling-turn': turn });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayed: true, appointment_id: 'existing', status: 'cancelled' });
    expect(createAppointment).toHaveBeenLastCalledWith(expect.objectContaining(create), turn);
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
