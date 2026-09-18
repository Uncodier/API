import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/database/supabase-client'
import { v4 as uuidv4 } from 'uuid'
import { visitorTrackingEventSchema } from '@/lib/validation/visitor-tracking-event'

/**
 * API DE TRACKING DE VISITANTES
 * 
 * Esta API permite registrar eventos de visitantes en el sitio web, incluyendo:
 * - Pageviews
 * - Clics
 * - Eventos personalizados
 * - Compras
 * - Acciones
 * - Movimientos del mouse
 * - Scroll
 * - Teclado
 * - Redimensionamiento
 * - Foco/blur
 * - Formularios
 * - Rendimiento
 * - Errores
 * - Grabación de sesión
 * 
 * Documentación completa: /docs/api/visitors/track
 */

// Función para validar y preparar datos para la base de datos
function validateAndPrepareEventData(eventData: any, eventId: string) {
  try {
    // Validar que los campos requeridos estén presentes
    if (!eventData.site_id || !eventData.event_type || !eventData.url) {
      return {
        valid: false,
        error: 'Faltan campos requeridos'
      };
    }

    // Preparar datos para la inserción
    const preparedData = {
      id: eventId,
      site_id: eventData.site_id,
      event_type: eventData.event_type,
      event_name: eventData.event_name || null,
      url: eventData.url,
      referrer: eventData.referrer || null,
      visitor_id: eventData.visitor_id || eventData.id || null,
      session_id: eventData.session_id || null,
      segment_id: eventData.segment_id || null,
      timestamp: eventData.timestamp || Date.now(),
      properties: eventData.properties || {},
      user_agent: eventData.user_agent || null,
      ip: eventData.ip || null,
      data: eventData
    };

    return {
      valid: true,
      data: preparedData
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Error desconocido'
    };
  }
}

// Función auxiliar para respuestas de error
function errorResponse(message: string, status: number, details?: any) {
  return NextResponse.json(
    {
      success: false,
      error: {
        message,
        details
      }
    },
    { status }
  );
}

export async function POST(request: NextRequest) {
  try {
    // Get request body
    const body = await request.json();
    
    // Validate request body
    const validationResult = visitorTrackingEventSchema.safeParse(body);
    
    if (!validationResult.success) {
      return errorResponse('Datos de solicitud inválidos', 400, validationResult.error.format());
    }
    
    const eventData = validationResult.data;
    
    // Get client IP and user agent from headers
    const headers = request.headers;
    const ip = headers.get('x-forwarded-for') || headers.get('x-real-ip') || eventData.ip;
    const userAgent = headers.get('user-agent') || eventData.user_agent;
    
    // Generate event ID
    const eventId = uuidv4();
    
    // Determinar el visitor_id (dar prioridad al visitor_id explícito, luego al id)
    const visitorId = eventData.visitor_id || eventData.id;

    // Initialize the session in one idempotent request instead of issuing a
    // read before every event.
    if (eventData.session_id && visitorId) {
      const timestamp = eventData.timestamp || Date.now();
      const { error: sessionError } = await supabaseAdmin
        .from('visitor_sessions')
        .upsert([{
          id: eventData.session_id,
          visitor_id: visitorId,
          site_id: eventData.site_id,
          landing_url: eventData.url,
          current_url: eventData.url,
          referrer: eventData.referrer,
          started_at: timestamp,
          last_activity_at: timestamp,
          page_views: 1,
          is_active: true,
        }], {
          onConflict: 'id',
          ignoreDuplicates: true,
        });

      if (sessionError) {
        console.error(
          '[POST /api/visitors/track] Failed to initialize session:',
          sessionError,
        );
        return errorResponse('Error al crear sesión', 500, sessionError);
      }
    }
    
    // Prepare data for database
    const dbData = {
      id: eventId,
      site_id: eventData.site_id,
      event_type: eventData.event_type,
      event_name: 'event_name' in eventData ? eventData.event_name : null,
      url: eventData.url,
      referrer: eventData.referrer,
      visitor_id: visitorId,
      session_id: eventData.session_id,
      segment_id: eventData.segment_id,
      timestamp: eventData.timestamp || Date.now(),
      properties: eventData.properties || {},
      user_agent: userAgent,
      ip: ip,
      data: {
        ...eventData,
        timestamp: eventData.timestamp || Date.now(),
        user_agent: userAgent,
        ip: ip
      }
    };
    
    // Get visitor's lead_id if available
    const { data: visitorData } = visitorId ? await supabaseAdmin
      .from('visitors')
      .select('lead_id')
      .eq('id', visitorId)
      .maybeSingle() : { data: null };

    // Insert event into database
    const { data, error } = await supabaseAdmin
      .from('session_events')
      .insert([dbData])
      .select('id, timestamp')
      .single();
    
    if (error) {
      console.error(`[POST /api/visitors/track] Error al insertar evento:`, error);
      return errorResponse('Error al registrar el evento', 500, error);
    }
    
    return NextResponse.json({
      success: true,
      event_id: data.id,
      visitor_id: visitorId,
      lead_id: visitorData?.lead_id || null,
      session_id: eventData.session_id,
      segment_id: eventData.segment_id || null,
      timestamp: data.timestamp
    });
    
  } catch (error: any) {
    console.error(`[POST /api/visitors/track] Error no manejado:`, error);
    return errorResponse('Error interno del servidor', 500, error.message);
  }
}