import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'
import { v4 as uuidv4 } from 'uuid'

export const dynamic = 'force-dynamic';

/**
 * API para cerrar explícitamente una sesión de visitante
 * 
 * Este endpoint permite cerrar una sesión de forma manual cuando el usuario
 * abandona el sitio, permitiendo registrar información adicional sobre
 * la salida como la URL final y el tipo de salida.
 */

// Esquema para validar el cierre de sesión
const EndSessionSchema = z.object({
  exit_url: z.string().url("exit_url debe ser una URL válida").optional(),
  exit_type: z.enum(["exit", "bounce", "timeout"]).optional(),
  duration: z.number().int().optional(),
  page_views: z.number().int().optional()
});

// Función auxiliar para generar respuesta de error
function errorResponse(message: string, status: number = 400, details: any = null) {
  return NextResponse.json({
    success: false,
    error: {
      code: status === 404 ? 'not_found' : 'bad_request',
      message,
      details,
      request_id: uuidv4()
    }
  }, { status });
}

/**
 * POST /api/visitors/session/{session_id}/end
 * 
 * Cierra explícitamente una sesión
 */
export async function POST(request: NextRequest) {
  try {
    // Extraer el ID de sesión de la URL
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/');
    const sessionIndex = pathSegments.findIndex(segment => segment === 'session') + 1;
    const sessionId = pathSegments[sessionIndex];
    
    // Verificar API key en el encabezado
    const apiKey = request.headers.get('X-SA-API-KEY');
    if (!apiKey) {
      return errorResponse('API Key no proporcionada', 401);
    }
    
    // TODO: Validar API key contra la base de datos
    
    // Validar el ID de sesión en la URL
    if (!sessionId) {
      return errorResponse('ID de sesión no proporcionado', 400);
    }
    
    // Obtener el site_id de los parámetros de la consulta
    const siteId = url.searchParams.get('site_id');
    if (!siteId) {
      return errorResponse('site_id es requerido como parámetro de consulta', 400);
    }
    
    // Validar el cuerpo de la solicitud
    const body = await request.json();
    const validationResult = EndSessionSchema.safeParse(body);
    
    if (!validationResult.success) {
      return errorResponse('Datos de solicitud inválidos', 400, validationResult.error.format());
    }
    
    const endData = validationResult.data;
    const startTime = Date.now();
    
    // Verificar que la sesión existe
    const { data: session, error: findError } = await supabaseAdmin
      .from('visitor_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('site_id', siteId)
      .single();
    
    if (findError || !session) {
      return errorResponse('Sesión no encontrada o ha expirado', 404, {
        session_id: sessionId,
        site_id: siteId
      });
    }
    
    // Calcular la duración si no se proporciona
    let duration = endData.duration;
    if (!duration && session.started_at) {
      duration = Date.now() - session.started_at;
    }
    
    // Preparar datos para la actualización
    const updates: any = {
      is_active: false,
      closed_at: Date.now(),
      updated_at: new Date().toISOString()
    };
    
    if (endData.exit_url) updates.exit_url = endData.exit_url;
    if (endData.exit_type) updates.exit_type = endData.exit_type;
    if (duration) updates.duration = duration;
    if (endData.page_views) updates.page_views = endData.page_views;
    
    // Actualizar la sesión en la base de datos
    const { data, error } = await supabaseAdmin
      .from('visitor_sessions')
      .update(updates)
      .eq('id', sessionId)
      .eq('site_id', siteId)
      .select()
      .single();
    
    if (error) {
      console.error('Error al cerrar la sesión:', error);
      return errorResponse(`Error al cerrar la sesión: ${error.message}`, 500);
    }
    
    // Devolver respuesta exitosa
    return NextResponse.json({
      success: true,
      data: {
        session_id: sessionId,
        closed_at: updates.closed_at,
        duration: updates.duration || session.duration
      },
      meta: {
        api_version: '1.0',
        server_time: Date.now(),
        processing_time: Date.now() - startTime
      }
    });
    
  } catch (error: any) {
    console.error('Error en POST /api/visitors/session/{session_id}/end:', error);
    return errorResponse(`Error interno del servidor: ${error.message}`, 500);
  }
} 