import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'
import { v4 as uuidv4 } from 'uuid'

/**
 * API para asociar un lead a una sesión de visitante
 * 
 * Este endpoint permite identificar a un visitante como un lead,
 * asociando su información de contacto y otros datos relevantes
 * a la sesión en curso.
 */

// Esquema para validar identificación de lead
const IdentifyLeadSchema = z.object({
  lead_id: z.string().uuid("lead_id debe ser un UUID válido"),
  lead_data: z.record(z.any()).optional()
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
 * POST /api/visitors/session/{session_id}/identify
 * 
 * Identifica un lead y lo asocia a una sesión
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { session_id: string } }
) {
  try {
    // Verificar API key en el encabezado
    const apiKey = request.headers.get('X-SA-API-KEY');
    if (!apiKey) {
      return errorResponse('API Key no proporcionada', 401);
    }
    
    // TODO: Validar API key contra la base de datos
    
    // Validar el ID de sesión en la URL
    const sessionId = params.session_id;
    if (!sessionId) {
      return errorResponse('ID de sesión no proporcionado', 400);
    }
    
    // Obtener el site_id de los parámetros de la consulta
    const url = new URL(request.url);
    const siteId = url.searchParams.get('site_id');
    if (!siteId) {
      return errorResponse('site_id es requerido como parámetro de consulta', 400);
    }
    
    // Validar el cuerpo de la solicitud
    const body = await request.json();
    const validationResult = IdentifyLeadSchema.safeParse(body);
    
    if (!validationResult.success) {
      return errorResponse('Datos de solicitud inválidos', 400, validationResult.error.format());
    }
    
    const identifyData = validationResult.data;
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
    
    // Preparar datos para la actualización
    const updates: any = {
      lead_id: identifyData.lead_id,
      lead_data: identifyData.lead_data || null,
      identified_at: Date.now(),
      updated_at: new Date().toISOString()
    };
    
    // Actualizar la sesión en la base de datos
    const { data, error } = await supabaseAdmin
      .from('visitor_sessions')
      .update(updates)
      .eq('id', sessionId)
      .eq('site_id', siteId)
      .select()
      .single();
    
    if (error) {
      console.error('Error al identificar lead en la sesión:', error);
      return errorResponse(`Error al identificar lead: ${error.message}`, 500);
    }
    
    // Devolver respuesta exitosa
    return NextResponse.json({
      success: true,
      data: {
        session_id: sessionId,
        lead_id: identifyData.lead_id,
        identified_at: updates.identified_at,
        visitor_id: session.visitor_id
      },
      meta: {
        api_version: '1.0',
        server_time: Date.now(),
        processing_time: Date.now() - startTime
      }
    });
    
  } catch (error: any) {
    console.error('Error en POST /api/visitors/session/{session_id}/identify:', error);
    return errorResponse(`Error interno del servidor: ${error.message}`, 500);
  }
} 