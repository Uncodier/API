import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { parse, isValid } from 'date-fns';
import { generateAvailableSlots } from '@/lib/scheduling/availability-slots';
import { localDateBoundsToUtc, localYmd, normalizeTimezone } from '@/lib/timezone';

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
function isValidUUID(uuid: string): boolean {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regex.test(uuid);
}

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
    const site_id = url.searchParams.get('site_id');
    const participants = url.searchParams.get('participants')?.split(',') || [];
    const resources = url.searchParams.get('resources')?.split(',') || [];
    
    // Validar parámetros requeridos
    if (!date || !site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'La fecha y el ID del sitio son requeridos'
        },
        { status: 400 }
      );
    }

    if (!isValidUUID(site_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'El ID del sitio debe ser un UUID válido'
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
    
    const tz = normalizeTimezone(timezone);

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

    if (date < localYmd(new Date(), tz)) {
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
      .select('id, name, members, site_id')
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

    if (teamData.site_id !== site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'El equipo no pertenece a este sitio'
        },
        { status: 403 }
      );
    }

    const teamMembersData: any[] = Array.isArray(teamData.members) ? teamData.members : [];

    const range = localDateBoundsToUtc(tz, date, date);
    const { data: existingMeetings, error: meetingsError } = await supabaseAdmin
      .from('tasks')
      .select('id, start_datetime, end_datetime, assignees, resources')
      .eq('type', 'meeting')
      .eq('site_id', site_id)
      .lt('start_datetime', range.end_utc)
      .gt('end_datetime', range.start_utc);
    
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
      tz
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
        timezone: tz,
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