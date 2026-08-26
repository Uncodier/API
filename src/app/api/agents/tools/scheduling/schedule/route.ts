import { NextRequest, NextResponse } from 'next/server';
import {
  appointmentPublicFields,
  createAppointment,
  listAppointments,
  updateAppointment,
} from '@/lib/scheduling/appointments';

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
    const body = await request.json();
    const action = body.action || 'schedule';
    const site_id = body.site_id;

    if (!site_id) {
      return NextResponse.json(
        { success: false, error: 'El ID del sitio es requerido' },
        { status: 400 }
      );
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

    const {
      title,
      start_datetime,
      duration,
      timezone,
      context_id,
      participants = [],
      location,
      description,
      reminder,
    } = body;

    if (!title) {
      return NextResponse.json(
        { success: false, error: 'El título y el ID del sitio son requeridos' },
        { status: 400 }
      );
    }
    if (!start_datetime) {
      return NextResponse.json(
        { success: false, error: 'La fecha y hora de inicio son requeridas' },
        { status: 400 }
      );
    }
    if (!duration || duration < 5) {
      return NextResponse.json(
        { success: false, error: 'La duración debe ser de al menos 5 minutos' },
        { status: 400 }
      );
    }
    if (!timezone) {
      return NextResponse.json(
        { success: false, error: 'La zona horaria es requerida' },
        { status: 400 }
      );
    }
    if (!context_id) {
      return NextResponse.json(
        { success: false, error: 'El ID de contexto es requerido' },
        { status: 400 }
      );
    }

    const appointment = await createAppointment({
      title,
      start_datetime,
      duration,
      timezone,
      context_id,
      site_id,
      participants,
      location,
      description,
      reminder,
    });

    return NextResponse.json(
      {
        success: true,
        ...appointmentPublicFields(appointment),
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error al procesar la programación de cita:', error);
    return httpError(error, 'Error al procesar la solicitud de programación');
  }
}
