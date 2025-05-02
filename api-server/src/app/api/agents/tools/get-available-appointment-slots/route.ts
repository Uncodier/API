import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { parse, format, isValid, addMinutes } from 'date-fns';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';

/**
 * Endpoint para obtener los horarios disponibles para programar citas o reuniones
 * 
 * @param request Solicitud entrante con los criterios de búsqueda
 * @returns Respuesta con los slots de tiempo disponibles
 * 
 * Parámetros de consulta:
 * - date: Fecha en formato YYYY-MM-DD (requerido)
 * - duration: Duración en minutos de la reunión (requerido, mínimo 15)
 * - timezone: Zona horaria (requerido)
 * - team_id: ID del equipo (requerido)
 * - start_time: Hora de inicio (opcional, default: 09:00)
 * - end_time: Hora de fin (opcional, default: 17:00)
 * - participants: Lista de IDs de participantes separados por coma (opcional)
 * - resources: Lista de IDs de recursos separados por coma (opcional)
 * 
 * Respuesta:
 * - success: Estado de la operación
 * - date: Fecha consultada
 * - timezone: Zona horaria
 * - available_slots: Array de slots disponibles con:
 *    - start: Hora de inicio (formato local)
 *    - end: Hora de fin (formato local)
 *    - start_utc: Hora de inicio en UTC
 *    - end_utc: Hora de fin en UTC
 *    - timezone: Zona horaria usada
 *    - available_participants: Lista de participantes disponibles con id, nombre y rol
 *    - available_resources: Lista de recursos disponibles
 *    - all_participants_available: Indica si todos los participantes solicitados están disponibles
 * - unavailable_participants: Lista de participantes no disponibles
 * - unavailable_resources: Lista de recursos no disponibles
 * - team_members: Lista de miembros del equipo con id, nombre y rol
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    
    // Extraer parámetros de la solicitud
    const date = url.searchParams.get('date');
    const duration = parseInt(url.searchParams.get('duration') || '0');
    const timezone = url.searchParams.get('timezone');
    const team_id = url.searchParams.get('team_id');
    const start_time = url.searchParams.get('start_time') || '09:00';
    const end_time = url.searchParams.get('end_time') || '17:00';
    const participants = url.searchParams.get('participants')?.split(',') || [];
    const resources = url.searchParams.get('resources')?.split(',') || [];
    
    // Validar parámetros requeridos
    if (!date) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'La fecha es requerida'
        },
        { status: 400 }
      );
    }
    
    if (!duration || duration < 15) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'La duración debe ser de al menos 15 minutos'
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
    
    if (!team_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'El ID del equipo es requerido'
        },
        { status: 400 }
      );
    }
    
    // Validar formato de fecha (YYYY-MM-DD)
    const dateObj = parse(date, 'yyyy-MM-dd', new Date());
    if (!isValid(dateObj)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'El formato de fecha no es válido. Usar formato YYYY-MM-DD'
        },
        { status: 422 }
      );
    }
    
    // Verificar si la fecha es en el pasado
    if (dateObj < new Date()) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'No se pueden consultar fechas en el pasado'
        },
        { status: 422 }
      );
    }
    
    // Verificar la existencia del equipo y obtener miembros con sus roles
    const { data: teamData, error: teamError } = await supabaseAdmin
      .from('teams')
      .select('id, name, members')
      .eq('id', team_id)
      .single();
    
    if (teamError) {
      console.error('Error al verificar el equipo:', teamError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Equipo no encontrado'
        },
        { status: 404 }
      );
    }

    // Obtener información detallada de los miembros del equipo
    const { data: teamMembersData, error: membersError } = await supabaseAdmin
      .from('users')
      .select('id, email, name, role')
      .in('id', teamData.members || []);
      
    if (membersError) {
      console.error('Error al obtener información de los miembros:', membersError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Error al obtener información de miembros'
        },
        { status: 500 }
      );
    }
    
    // Si no hay miembros en el equipo, considerar solo al usuario admin
    if (!teamMembersData || teamMembersData.length === 0) {
      // Obtener el usuario administrador
      const { data: adminUser, error: adminError } = await supabaseAdmin
        .from('users')
        .select('id, email, name, role')
        .eq('role', 'admin')
        .limit(1)
        .single();
        
      if (adminError) {
        console.error('Error al obtener usuario admin:', adminError);
        return NextResponse.json(
          { 
            success: false, 
            error: 'No se pudo determinar un usuario disponible'
          },
          { status: 500 }
        );
      }
      
      teamMembersData.push(adminUser);
    }
    
    // Obtener tareas de tipo "meeting" para la fecha especificada
    const dateStr = format(dateObj, 'yyyy-MM-dd');
    const { data: existingMeetings, error: meetingsError } = await supabaseAdmin
      .from('tasks')
      .select('id, start_datetime, end_datetime, assignees, resources')
      .eq('type', 'meeting')
      .ilike('start_datetime', `${dateStr}%`);
    
    if (meetingsError) {
      console.error('Error al obtener reuniones existentes:', meetingsError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Error al consultar la disponibilidad'
        },
        { status: 500 }
      );
    }
    
    // Generar slots disponibles
    const availableSlots = generateAvailableSlots(
      date,
      start_time,
      end_time,
      duration,
      existingMeetings,
      participants,
      resources,
      teamMembersData,
      timezone
    );
    
    // Determinar participantes y recursos no disponibles
    const unavailableParticipants = participants.filter(p => 
      !availableSlots.some(slot => slot.available_participants.some(ap => ap.id === p))
    );
    
    const unavailableResources = resources.filter(r => 
      !availableSlots.some(slot => slot.available_resources.includes(r))
    );
    
    // Respuesta exitosa
    return NextResponse.json(
      {
        success: true,
        date,
        timezone,
        available_slots: availableSlots,
        unavailable_participants: unavailableParticipants,
        unavailable_resources: unavailableResources,
        team_members: teamMembersData.map(m => ({ id: m.id, name: m.name, role: m.role }))
      },
      { status: 200 }
    );
    
  } catch (error) {
    console.error('Error al procesar la consulta de slots disponibles:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Error al procesar la solicitud'
      },
      { status: 500 }
    );
  }
}

/**
 * Genera slots de tiempo disponibles basado en los criterios
 * 
 * @param date Fecha en formato YYYY-MM-DD
 * @param startTimeStr Hora de inicio en formato HH:MM
 * @param endTimeStr Hora de fin en formato HH:MM
 * @param duration Duración del slot en minutos
 * @param existingMeetings Lista de reuniones existentes
 * @param requestedParticipants Lista de IDs de participantes requeridos
 * @param requestedResources Lista de recursos requeridos
 * @param teamMembers Lista de miembros del equipo con información detallada
 * @param timezone Zona horaria
 * @returns Lista de slots disponibles
 */
function generateAvailableSlots(
  date: string,
  startTimeStr: string,
  endTimeStr: string,
  duration: number,
  existingMeetings: any[],
  requestedParticipants: string[],
  requestedResources: string[],
  teamMembers: any[],
  timezone: string
) {
  const slots = [];
  const dateObj = parse(date, 'yyyy-MM-dd', new Date());
  
  // Convertir horas locales a UTC basadas en la zona horaria
  const startTimeLocal = parse(startTimeStr, 'HH:mm', dateObj);
  const endTimeLocal = parse(endTimeStr, 'HH:mm', dateObj);
  
  const startTime = toZonedTime(startTimeLocal, timezone);
  const endTime = toZonedTime(endTimeLocal, timezone);
  
  // Generar slots con intervalos del tamaño de la duración requerida
  let currentSlotStart = startTime;
  
  while (addMinutes(currentSlotStart, duration) <= endTime) {
    const slotEnd = addMinutes(currentSlotStart, duration);
    
    // Verificar si el slot está disponible
    const { 
      isAvailable, 
      availableParticipants, 
      availableResources 
    } = checkSlotAvailability(
      currentSlotStart,
      slotEnd,
      existingMeetings,
      requestedParticipants,
      requestedResources,
      teamMembers
    );
    
    // Crear el slot con información de zona horaria
    const startFormatted = formatInTimeZone(currentSlotStart, timezone, 'HH:mm');
    const endFormatted = formatInTimeZone(slotEnd, timezone, 'HH:mm');
    
    // Incluir slots aunque no estén todos los participantes disponibles
    // para que el agente pueda decidir basado en los roles
    if (isAvailable || availableParticipants.length > 0) {
      slots.push({
        start: startFormatted,
        end: endFormatted,
        start_utc: currentSlotStart.toISOString(),
        end_utc: slotEnd.toISOString(),
        timezone,
        available_participants: availableParticipants,
        available_resources: availableResources,
        all_participants_available: isAvailable
      });
    }
    
    // Avanzar al siguiente slot
    currentSlotStart = addMinutes(currentSlotStart, 30); // Intervalos de 30 minutos
  }
  
  return slots;
}

/**
 * Verifica la disponibilidad de un slot específico
 * 
 * @param slotStart Fecha/hora de inicio del slot
 * @param slotEnd Fecha/hora de fin del slot
 * @param existingMeetings Lista de reuniones existentes
 * @param requestedParticipants Lista de IDs de participantes requeridos
 * @param requestedResources Lista de recursos requeridos
 * @param teamMembers Lista de miembros del equipo con información detallada
 * @returns Objeto con la disponibilidad, participantes disponibles y recursos disponibles
 */
function checkSlotAvailability(
  slotStart: Date,
  slotEnd: Date,
  existingMeetings: any[],
  requestedParticipants: string[],
  requestedResources: string[],
  teamMembers: any[]
) {
  // Inicializar con todos los miembros del equipo
  const availableParticipants = [...teamMembers];
  const availableResources = [...requestedResources];
  
  // Verificar conflictos con reuniones existentes
  for (const meeting of existingMeetings) {
    const meetingStart = new Date(meeting.start_datetime);
    const meetingEnd = new Date(meeting.end_datetime);
    
    // Verificar si hay solapamiento de horarios
    const overlaps = (
      slotStart < meetingEnd && 
      slotEnd > meetingStart
    );
    
    if (overlaps) {
      // Verificar participantes no disponibles
      const meetingParticipants = meeting.assignees || [];
      
      // Remover participantes que están ocupados en ese horario
      availableParticipants.forEach((participant, index) => {
        if (meetingParticipants.includes(participant.id)) {
          availableParticipants.splice(index, 1);
        }
      });
      
      // Remover recursos que están ocupados en ese horario
      const meetingResources = meeting.resources || [];
      meetingResources.forEach((resource: string) => {
        const index = availableResources.indexOf(resource);
        if (index !== -1) {
          availableResources.splice(index, 1);
        }
      });
    }
  }
  
  // El slot es disponible si todos los participantes y recursos requeridos están disponibles
  const allParticipantsAvailable = requestedParticipants.every(p => 
    availableParticipants.some(ap => ap.id === p)
  );
  
  const allResourcesAvailable = requestedResources.every(r => 
    availableResources.includes(r)
  );
  
  return {
    isAvailable: allParticipantsAvailable && allResourcesAvailable,
    availableParticipants,
    availableResources
  };
} 