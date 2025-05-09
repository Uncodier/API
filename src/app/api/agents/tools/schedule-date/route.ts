import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { isValid, parseISO, addMinutes, formatISO, isPast } from 'date-fns';

/**
 * Endpoint para programar una cita o fecha para un evento específico
 * 
 * @param request Solicitud entrante con los datos de la cita
 * @returns Respuesta con la información de la cita programada
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Extraer parámetros requeridos
    const { 
      title,
      start_datetime,
      duration,
      timezone,
      context_id,
      participants = [],
      location,
      description,
      reminder
    } = body;
    
    // Validar parámetros requeridos
    if (!title) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'El título es requerido'
        },
        { status: 400 }
      );
    }
    
    if (!start_datetime) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'La fecha y hora de inicio son requeridas'
        },
        { status: 400 }
      );
    }
    
    if (!duration || duration < 5) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'La duración debe ser de al menos 5 minutos'
        },
        { status: 400 }
      );
    }
    
    if (!timezone) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'La zona horaria es requerida'
        },
        { status: 400 }
      );
    }
    
    if (!context_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'El ID de contexto es requerido'
        },
        { status: 400 }
      );
    }
    
    // Validar formato de fecha
    const startDate = parseISO(start_datetime);
    if (!isValid(startDate)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'El formato de fecha y hora no es válido. Usar formato ISO 8601'
        },
        { status: 422 }
      );
    }
    
    // Verificar si la fecha es en el pasado
    if (isPast(startDate)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'No se puede programar una cita en el pasado'
        },
        { status: 422 }
      );
    }
    
    // Calcular fecha y hora de fin
    const endDate = addMinutes(startDate, duration);
    const end_datetime = formatISO(endDate);
    
    // Verificar disponibilidad de horario
    const isAvailable = await checkAvailability(start_datetime, end_datetime, participants);
    
    if (!isAvailable) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'El horario solicitado no está disponible',
          status: 'conflict'
        },
        { status: 409 }
      );
    }
    
    // Crear registro de cita
    const appointment_id = uuidv4();
    const calendarLink = generateCalendarLink(appointment_id);
    
    const appointmentData = {
      id: appointment_id,
      title,
      start_datetime,
      end_datetime,
      duration,
      timezone,
      context_id,
      participants,
      location,
      description,
      reminder,
      status: 'confirmed',
      calendar_link: calendarLink,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    const { data: appointment, error: insertError } = await supabaseAdmin
      .from('appointments')
      .insert([appointmentData])
      .select()
      .single();
    
    if (insertError) {
      console.error('Error al crear la cita:', insertError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Error al programar la cita'
        },
        { status: 500 }
      );
    }
    
    // Respuesta exitosa
    return NextResponse.json(
      {
        success: true,
        appointment_id: appointment.id,
        title: appointment.title,
        start_datetime: appointment.start_datetime,
        end_datetime: appointment.end_datetime,
        timezone: appointment.timezone,
        status: appointment.status,
        calendar_link: appointment.calendar_link
      },
      { status: 201 }
    );
    
  } catch (error) {
    console.error('Error al procesar la programación de cita:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Error al procesar la solicitud de programación'
      },
      { status: 500 }
    );
  }
}

/**
 * Verifica la disponibilidad de horario para la cita
 */
async function checkAvailability(start: string, end: string, participants: string[]) {
  // Verificar si hay conflictos con citas existentes
  const { data: existingAppointments, error } = await supabaseAdmin
    .from('appointments')
    .select('id, start_datetime, end_datetime, participants')
    .or(`start_datetime.gte.${start},end_datetime.lte.${end}`)
    .eq('status', 'confirmed');
  
  if (error) {
    console.error('Error al verificar disponibilidad:', error);
    // En caso de error, asumimos que no hay disponibilidad
    return false;
  }
  
  // Si no hay participantes, solo verificamos si hay citas en ese horario
  if (participants.length === 0) {
    return existingAppointments.length === 0;
  }
  
  // Verificar si alguno de los participantes ya tiene una cita en ese horario
  for (const appointment of existingAppointments) {
    const appointmentParticipants = appointment.participants || [];
    const hasConflict = participants.some(participant => 
      appointmentParticipants.includes(participant)
    );
    
    if (hasConflict) {
      return false;
    }
  }
  
  return true;
}

/**
 * Genera un enlace para el calendario
 */
function generateCalendarLink(appointmentId: string) {
  return `https://cal.example.com/event/${appointmentId}`;
} 