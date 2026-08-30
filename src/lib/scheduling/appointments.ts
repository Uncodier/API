import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { isValid, addMinutes, isPast } from 'date-fns';
import {
  DEFAULT_TIMEZONE,
  formatInTimezone,
  localDateBoundsToUtc,
  normalizeTimezone,
  parseInstantOrWallClock,
} from '@/lib/timezone';

export interface AppointmentRow {
  id: string;
  title: string;
  start_datetime: string;
  end_datetime: string;
  duration: number;
  timezone: string;
  context_id: string;
  site_id: string;
  participants?: string[];
  location?: string | null;
  description?: string | null;
  reminder?: number | string | null;
  status: string;
  calendar_link?: string | null;
}

export interface ListAppointmentsParams {
  site_id: string;
  context_id?: string;
  status?: string;
  date?: string;
  timezone?: string;
  limit?: number;
}

/** UTC bounds for a YYYY-MM-DD calendar day in the client timezone (not a UTC midnight slice). */
export function appointmentListUtcRange(date: string, timezone?: string) {
  return localDateBoundsToUtc(normalizeTimezone(timezone || DEFAULT_TIMEZONE), date, date);
}

export interface CreateAppointmentParams {
  title: string;
  start_datetime: string;
  duration: number;
  timezone: string;
  context_id: string;
  site_id: string;
  participants?: string[];
  location?: string;
  description?: string;
  reminder?: number | string;
}

export interface UpdateAppointmentParams {
  appointment_id: string;
  site_id: string;
  title?: string;
  start_datetime?: string;
  duration?: number;
  timezone?: string;
  status?: string;
  location?: string;
  description?: string;
  reminder?: number | string;
  participants?: string[];
}

function generateCalendarLink(appointmentId: string): string {
  return `https://cal.example.com/event/${appointmentId}`;
}

export async function checkAppointmentAvailability(
  start: string,
  end: string,
  site_id: string,
  participants: string[],
  excludeId?: string
): Promise<boolean> {
  const schema = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public';
  let query = supabaseAdmin
    .schema(schema)
    .from('appointments')
    .select('id, start_datetime, end_datetime, participants')
    .eq('site_id', site_id)
    .or(`start_datetime.gte.${start},end_datetime.lte.${end}`)
    .eq('status', 'confirmed');

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data: existingAppointments, error } = await query;

  if (error) {
    console.error('Error al verificar disponibilidad:', error);
    return false;
  }

  const rows = existingAppointments || [];
  if (participants.length === 0) {
    return rows.length === 0;
  }

  for (const appointment of rows) {
    const appointmentParticipants = appointment.participants || [];
    const hasConflict = participants.some((participant) =>
      appointmentParticipants.includes(participant)
    );
    if (hasConflict) {
      return false;
    }
  }

  return true;
}

export async function listAppointments(params: ListAppointmentsParams): Promise<AppointmentRow[]> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);

  const schema = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public';
  let query = supabaseAdmin
    .schema(schema)
    .from('appointments')
    .select(
      'id, title, start_datetime, end_datetime, duration, timezone, context_id, site_id, participants, location, status, calendar_link'
    )
    .eq('site_id', params.site_id);

  if (params.context_id) {
    query = query.eq('context_id', params.context_id);
  }

  if (params.status) {
    query = query.eq('status', params.status);
  } else {
    query = query.neq('status', 'cancelled');
  }

  if (params.date) {
    const range = appointmentListUtcRange(params.date, params.timezone);
    query = query.gte('start_datetime', range.start_utc).lt('start_datetime', range.end_utc);
  }

  const { data, error } = await query.order('start_datetime', { ascending: true }).limit(limit);
  if (error) {
    throw new Error(error.message);
  }
  return (data || []) as AppointmentRow[];
}

export async function createAppointment(params: CreateAppointmentParams): Promise<AppointmentRow> {
  const startDate = parseInstantOrWallClock(params.start_datetime, params.timezone);
  if (!isValid(startDate)) {
    throw Object.assign(new Error('El formato de fecha y hora no es válido. Usar formato ISO 8601'), { status: 422 });
  }
  if (isPast(startDate)) {
    throw Object.assign(new Error('No se puede programar una cita en el pasado'), { status: 422 });
  }

  const endDate = addMinutes(startDate, params.duration);
  const startUtc = startDate.toISOString();
  const end_datetime = endDate.toISOString();
  const participants = params.participants || [];

  const isAvailable = await checkAppointmentAvailability(
    startUtc,
    end_datetime,
    params.site_id,
    participants
  );
  if (!isAvailable) {
    throw Object.assign(new Error('El horario solicitado no está disponible'), {
      status: 409,
      code: 'conflict',
    });
  }

  const appointment_id = uuidv4();
  const appointmentData = {
    id: appointment_id,
    title: params.title,
    start_datetime: startUtc,
    end_datetime,
    duration: params.duration,
    timezone: params.timezone,
    context_id: params.context_id,
    site_id: params.site_id,
    participants,
    location: params.location,
    description: params.description,
    reminder: params.reminder,
    status: 'confirmed',
    calendar_link: generateCalendarLink(appointment_id),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const schema = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public';
  const { data: appointment, error } = await supabaseAdmin
    .schema(schema)
    .from('appointments')
    .insert([appointmentData])
    .select()
    .single();

  if (error) {
    throw new Error('Error al programar la cita');
  }

  return appointment as AppointmentRow;
}

export async function updateAppointment(params: UpdateAppointmentParams): Promise<AppointmentRow> {
  const schema = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public';
  const { data: existing, error: getError } = await supabaseAdmin
    .schema(schema)
    .from('appointments')
    .select('*')
    .eq('id', params.appointment_id)
    .eq('site_id', params.site_id)
    .single();

  if (getError || !existing) {
    throw Object.assign(new Error('Appointment not found'), { status: 404 });
  }

  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (params.title !== undefined) payload.title = params.title;
  if (params.location !== undefined) payload.location = params.location;
  if (params.description !== undefined) payload.description = params.description;
  if (params.reminder !== undefined) payload.reminder = params.reminder;
  if (params.participants !== undefined) payload.participants = params.participants;
  if (params.status !== undefined) payload.status = params.status;

  const movingTime =
    params.start_datetime !== undefined ||
    params.duration !== undefined ||
    params.timezone !== undefined;

  if (movingTime) {
    const timezone = params.timezone || existing.timezone;
    const duration = params.duration ?? existing.duration;
    const startInput = params.start_datetime || existing.start_datetime;
    const startDate = parseInstantOrWallClock(startInput, timezone);
    if (!isValid(startDate)) {
      throw Object.assign(new Error('El formato de fecha y hora no es válido. Usar formato ISO 8601'), {
        status: 422,
      });
    }
    if (isPast(startDate)) {
      throw Object.assign(new Error('No se puede programar una cita en el pasado'), { status: 422 });
    }

    const endDate = addMinutes(startDate, duration);
    const startUtc = startDate.toISOString();
    const end_datetime = endDate.toISOString();
    const participants = params.participants || existing.participants || [];
    const nextStatus = params.status || existing.status;

    if (nextStatus !== 'cancelled') {
      const isAvailable = await checkAppointmentAvailability(
        startUtc,
        end_datetime,
        params.site_id,
        participants,
        params.appointment_id
      );
      if (!isAvailable) {
        throw Object.assign(new Error('El horario solicitado no está disponible'), {
          status: 409,
          code: 'conflict',
        });
      }
    }

    payload.start_datetime = startUtc;
    payload.end_datetime = end_datetime;
    payload.duration = duration;
    payload.timezone = timezone;
  }

  const { data: appointment, error } = await supabaseAdmin
    .schema(schema)
    .from('appointments')
    .update(payload)
    .eq('id', params.appointment_id)
    .eq('site_id', params.site_id)
    .select()
    .single();

  if (error || !appointment) {
    throw new Error('Error al actualizar la cita');
  }

  return appointment as AppointmentRow;
}

export function appointmentPublicFields(appointment: AppointmentRow) {
  const tz = normalizeTimezone(appointment.timezone || DEFAULT_TIMEZONE);
  return {
    appointment_id: appointment.id,
    title: appointment.title,
    start: formatInTimezone(appointment.start_datetime, tz, 'HH:mm'),
    end: formatInTimezone(appointment.end_datetime, tz, 'HH:mm'),
    local_start: formatInTimezone(appointment.start_datetime, tz, 'yyyy-MM-dd HH:mm'),
    local_end: formatInTimezone(appointment.end_datetime, tz, 'yyyy-MM-dd HH:mm'),
    start_datetime: appointment.start_datetime,
    end_datetime: appointment.end_datetime,
    start_utc: appointment.start_datetime,
    end_utc: appointment.end_datetime,
    timezone: tz,
    status: appointment.status,
    calendar_link: appointment.calendar_link,
    context_id: appointment.context_id,
    duration: appointment.duration,
    participants: appointment.participants,
  };
}
