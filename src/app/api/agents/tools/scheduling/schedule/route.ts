import { z } from 'zod';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';
import { NextRequest, NextResponse } from 'next/server';
import {
  appointmentPublicFields,
  createAppointment,
  listAppointments,
  updateAppointment,
} from '@/lib/scheduling/appointments';

const uuid = z.string().uuid();
const createInput = z.object({
  site_id: uuid, context_id: uuid, title: z.string().min(1), start_datetime: z.string().min(1),
  duration: z.number().int().min(5), timezone: z.string().min(1),
  participants: z.array(z.string().trim().min(1)).optional(), location: z.string().nullish(),
  description: z.string().nullish(), reminder: z.union([z.number(), z.string()]).nullish(),
});

function httpError(error: unknown, fallback: string) {
  const err = error as { message?: string; status?: number; code?: string };
  const status = err.status || 500;
  const body: Record<string, unknown> = {
    success: false,
    error: err.message || fallback,
  };
  if (err.code) body.status = err.code;
  return NextResponse.json(body, { status });
}

/**
 * Schedule, list, or update team/person appointments.
 * Default action is "schedule" for backward compatibility.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await resolveToolRequestPrincipal(request);
    if (!principal) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const body = await request.json();
    const action = body.action || 'schedule';
    const site_id = body.site_id;

    if (!uuid.safeParse(site_id).success) {
      return NextResponse.json({ success: false, error: 'Invalid site ID' }, { status: 400 });
    }
    if (!await canToolPrincipalAccessSite(principal, site_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }

    if (action === 'list') {
      const context_id = body.context_id || body.lead_id;
      const appointments = await listAppointments({
        site_id,
        context_id,
        status: body.status,
        date: body.date,
        timezone: body.timezone,
        limit: body.limit,
      });
      return NextResponse.json({
        success: true,
        appointments: appointments.map(appointmentPublicFields),
        count: appointments.length,
      });
    }

    if (action === 'update') {
      const appointment_id = body.appointment_id || body.id;
      if (!appointment_id) {
        return NextResponse.json(
          { success: false, error: 'appointment_id is required for update' },
          { status: 400 }
        );
      }

      const appointment = await updateAppointment({
        appointment_id,
        site_id,
        title: body.title,
        start_datetime: body.start_datetime,
        duration: body.duration,
        timezone: body.timezone,
        status: body.status,
        location: body.location,
        description: body.description,
        reminder: body.reminder,
        participants: Array.isArray(body.participants) ? body.participants : undefined,
      });

      return NextResponse.json({
        success: true,
        ...appointmentPublicFields(appointment),
      });
    }

    if (action !== 'schedule') {
      return NextResponse.json(
        { success: false, error: `Invalid action: ${action}. Use schedule, list, or update.` },
        { status: 400 }
      );
    }

    const parsed = createInput.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: 'Invalid appointment details' }, { status: 400 });
    }
    const turn = request.headers.get('x-native-scheduling-turn');
    if (turn !== null && (!principal.internal || !uuid.safeParse(turn).success)) {
      return NextResponse.json({ success: false, error: 'Invalid native scheduling scope' }, { status: 403 });
    }
    const { appointment, replayed } = await createAppointment({
      ...parsed.data, reminder: parsed.data.reminder ?? undefined,
      location: parsed.data.location ?? undefined, description: parsed.data.description ?? undefined,
    }, turn ?? undefined);
    return NextResponse.json({ success: true, ...appointmentPublicFields(appointment), replayed },
      { status: replayed ? 200 : 201 });
  } catch (error) {
    console.error('Error al procesar la programación de cita:', error);
    return httpError(error, 'Error al procesar la solicitud de programación');
  }
}
