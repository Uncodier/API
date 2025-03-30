import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'
import { v4 as uuidv4 } from 'uuid'

/**
 * API DE SESIONES DE VISITANTES
 * 
 * Esta API permite gestionar las sesiones de los visitantes. Una sesión representa 
 * un periodo de actividad continua de un usuario en un sitio web.
 * 
 * Características principales:
 * - Creación de nuevas sesiones
 * - Recuperación de datos de sesiones existentes
 * - Actualización de sesiones activas
 * - Cierre explícito de sesiones
 * - Asociación de sesiones con leads
 * 
 * Documentación completa: /docs/api/visitors/session
 */

// Función para validar y preparar datos para la base de datos
function validateAndPrepareSessionData(sessionData: any, sessionId: string, visitorId: string, startTime: number) {
  try {
    // Verificar campos obligatorios para la tabla visitor_sessions
    const requiredFields = ['session_id', 'site_id', 'visitor_id'];
    const missingFields = requiredFields.filter(field => {
      if (field === 'session_id') return !sessionId;
      if (field === 'visitor_id') return !visitorId;
      return !sessionData[field];
    });

    if (missingFields.length > 0) {
      return {
        valid: false,
        error: `Campos obligatorios faltantes: ${missingFields.join(', ')}`,
        data: null
      };
    }

    // Comprobar validez de valores clave
    if (sessionData.site_id && !isValidUUID(sessionData.site_id)) {
      return {
        valid: false,
        error: 'site_id debe ser un UUID válido',
        data: null
      };
    }

    // Preparar datos para la inserción, manejando correctamente tipos de datos
    const preparedData = {
      id: uuidv4(), // ID de la fila
      session_id: sessionId,
      visitor_id: visitorId,
      site_id: sessionData.site_id,
      landing_url: sessionData.url || null,
      current_url: sessionData.url || null,
      referrer: sessionData.referrer || null,
      utm_source: sessionData.utm_source || null,
      utm_medium: sessionData.utm_medium || null,
      utm_campaign: sessionData.utm_campaign || null,
      utm_term: sessionData.utm_term || null,
      utm_content: sessionData.utm_content || null,
      started_at: startTime,
      last_activity_at: startTime,
      page_views: 1,
      device: sessionData.device ? JSON.stringify(sessionData.device) : null,
      browser: sessionData.browser ? JSON.stringify(sessionData.browser) : null,
      location: sessionData.location ? JSON.stringify(sessionData.location) : null,
      previous_session_id: sessionData.previous_session_id || null,
      performance: sessionData.performance ? JSON.stringify(sessionData.performance) : null,
      consent: sessionData.consent ? JSON.stringify(sessionData.consent) : null,
      is_active: true,
    };

    return {
      valid: true,
      error: null,
      data: preparedData
    };
  } catch (error: any) {
    return {
      valid: false,
      error: `Error al validar datos: ${error.message}`,
      data: null
    };
  }
}

// Función para validar UUID
function isValidUUID(uuid: string) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Esquema para validar el cuerpo de la solicitud POST (crear sesión)
const CreateSessionSchema = z.object({
  // Campos obligatorios
  site_id: z.string().uuid("site_id debe ser un UUID válido"),
  
  // Campos opcionales
  visitor_id: z.string().optional(),
  url: z.string().url("URL debe ser válida").optional(),
  referrer: z.string().optional(),
  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
  utm_term: z.string().optional(),
  utm_content: z.string().optional(),
  device: z.object({
    type: z.string().optional(),
    screen_size: z.string().optional(),
    os: z.object({
      name: z.string().optional(),
      version: z.string().optional()
    }).optional(),
    pixel_ratio: z.number().optional(),
    orientation: z.string().optional(),
    memory: z.number().optional(),
    cpu_cores: z.number().optional(),
    touch_support: z.boolean().optional()
  }).optional(),
  browser: z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    language: z.string().optional()
  }).optional(),
  location: z.object({
    country: z.string().optional(),
    region: z.string().optional(),
    city: z.string().optional()
  }).optional(),
  previous_session_id: z.string().optional(),
  performance: z.object({
    page_load_time: z.number().optional(),
    first_paint: z.number().optional(),
    first_contentful_paint: z.number().optional(),
    dom_interactive: z.number().optional()
  }).optional(),
  consent: z.object({
    necessary: z.boolean().optional(),
    analytics: z.boolean().optional(),
    marketing: z.boolean().optional(),
    preferences: z.boolean().optional()
  }).optional()
});

// Esquema para validar el cuerpo de la solicitud PUT (actualizar sesión)
const UpdateSessionSchema = z.object({
  // Campos obligatorios
  session_id: z.string().uuid("session_id debe ser un UUID válido"),
  site_id: z.string().uuid("site_id debe ser un UUID válido"),
  
  // Campos opcionales
  last_activity_at: z.number().optional(),
  current_url: z.string().url("current_url debe ser una URL válida").optional(),
  page_views: z.number().int().optional(),
  active_time: z.number().int().optional(),
  custom_data: z.record(z.any()).optional()
});

// Esquema para validar los parámetros de URL en GET
const GetSessionParamsSchema = z.object({
  session_id: z.string().uuid("session_id debe ser un UUID válido"),
  site_id: z.string().uuid("site_id debe ser un UUID válido")
});

// Esquema para validar el cierre de sesión
const EndSessionSchema = z.object({
  exit_url: z.string().url("exit_url debe ser una URL válida").optional(),
  exit_type: z.enum(["exit", "bounce", "timeout"]).optional(),
  duration: z.number().int().optional(),
  page_views: z.number().int().optional()
});

// Esquema para validar identificación de lead
const IdentifyLeadSchema = z.object({
  lead_id: z.string().uuid("lead_id debe ser un UUID válido"),
  lead_data: z.record(z.any()).optional()
});

// Función auxiliar para generar respuesta de error
function errorResponse(message: string, status: number = 400, details: any = null) {
  console.log(`[ERROR] Status: ${status}, Message: ${message}`, details);
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
 * Crear una nueva sesión (POST)
 */
export async function POST(request: NextRequest) {
  console.log("[POST /api/visitors/session] Iniciando solicitud POST");
  try {
    // Verificar API key en el encabezado
    const apiKey = request.headers.get('X-SA-API-KEY');
    console.log(`[POST /api/visitors/session] API Key presente: ${!!apiKey}`);
    if (!apiKey) {
      return errorResponse('API Key no proporcionada', 401);
    }
    
    // TODO: Validar API key contra la base de datos
    console.log(`[POST /api/visitors/session] Validando cuerpo de solicitud`);
    
    // Validar el cuerpo de la solicitud
    const body = await request.json();
    console.log(`[POST /api/visitors/session] Cuerpo recibido:`, body);
    const validationResult = CreateSessionSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.log(`[POST /api/visitors/session] Error de validación:`, validationResult.error.format());
      return errorResponse('Datos de solicitud inválidos', 400, validationResult.error.format());
    }
    
    const sessionData = validationResult.data;
    console.log(`[POST /api/visitors/session] Datos validados:`, sessionData);
    
    // Generar IDs y marcas de tiempo
    const sessionId = uuidv4();
    const visitorId = sessionData.visitor_id || uuidv4();
    const startTime = Date.now();
    console.log(`[POST /api/visitors/session] Generados sessionId: ${sessionId}, visitorId: ${visitorId}`);
    
    // Validar y preparar datos para la base de datos
    const validation = validateAndPrepareSessionData(sessionData, sessionId, visitorId, startTime);
    if (!validation.valid) {
      console.error(`[POST /api/visitors/session] Error de validación de datos para DB:`, validation.error);
      return errorResponse(`Error al preparar datos: ${validation.error}`, 400);
    }
    
    const newSession = validation.data;
    
    try {
      // Primero, verificar si el visitante ya existe
      console.log(`[POST /api/visitors/session] Verificando si el visitante existe en la base de datos...`);
      const { data: existingVisitor, error: visitorCheckError } = await supabaseAdmin
        .from('visitors')
        .select('visitor_id')
        .eq('visitor_id', visitorId)
        .single();
      
      // Si el visitante no existe, crearlo primero
      if (!existingVisitor || visitorCheckError) {
        console.log(`[POST /api/visitors/session] Visitante no existe, creando nuevo visitante con ID: ${visitorId}`);
        
        // Crear nuevo registro de visitante
        const newVisitor = {
          id: uuidv4(),
          visitor_id: visitorId,
          first_seen_at: startTime,
          last_seen_at: startTime,
          total_sessions: 1,
          total_page_views: 1,
          total_time_spent: 0,
          first_url: sessionData.url || null,
          first_referrer: sessionData.referrer || null,
          first_utm_source: sessionData.utm_source || null,
          first_utm_medium: sessionData.utm_medium || null,
          first_utm_campaign: sessionData.utm_campaign || null,
          first_utm_term: sessionData.utm_term || null,
          first_utm_content: sessionData.utm_content || null,
          device: sessionData.device ? JSON.stringify(sessionData.device) : null,
          browser: sessionData.browser ? JSON.stringify(sessionData.browser) : null,
          location: sessionData.location ? JSON.stringify(sessionData.location) : null,
          is_identified: false
        };
        
        console.log(`[POST /api/visitors/session] Insertando nuevo visitante:`, newVisitor);
        
        const { error: visitorInsertError } = await supabaseAdmin
          .from('visitors')
          .insert([newVisitor]);
        
        if (visitorInsertError) {
          console.error(`[POST /api/visitors/session] Error al crear visitante:`, visitorInsertError);
          return errorResponse(`Error al crear visitante: ${visitorInsertError.message || 'Error desconocido'}`, 500);
        }
        
        console.log(`[POST /api/visitors/session] Visitante creado con éxito`);
      } else {
        console.log(`[POST /api/visitors/session] Visitante ya existe, actualizando datos...`);
        
        // Actualizar visitante existente
        const { error: visitorUpdateError } = await supabaseAdmin
          .from('visitors')
          .update({
            last_seen_at: startTime,
            total_sessions: supabaseAdmin.rpc('increment', { value: 1 })
          })
          .eq('visitor_id', visitorId);
        
        if (visitorUpdateError) {
          console.error(`[POST /api/visitors/session] Error al actualizar visitante:`, visitorUpdateError);
          // No devolver error, continuar con la creación de sesión
        }
      }
      
      // Ahora insertar la sesión
      console.log('[POST /api/visitors/session] Ejecutando query de inserción de sesión...');
      console.log(`[POST /api/visitors/session] Insertando en base de datos:`, newSession);
      
      const supabaseResponse = await supabaseAdmin
        .from('visitor_sessions')
        .insert([newSession])
        .select()
        .single();
      
      const { data, error } = supabaseResponse;
      
      console.log('[POST /api/visitors/session] Respuesta completa de Supabase:', JSON.stringify(supabaseResponse));
      
      if (error) {
        console.error('[POST /api/visitors/session] Error al crear la sesión:', error);
        console.error('[POST /api/visitors/session] Error details:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        return errorResponse(`Error al crear la sesión: ${error.message || 'Error desconocido en la base de datos'}`, 500);
      }
      
      if (!data) {
        console.error('[POST /api/visitors/session] No se recibieron datos aunque no hubo error');
        return errorResponse('Error al crear la sesión: No se recibieron datos de confirmación', 500);
      }
      
      console.log(`[POST /api/visitors/session] Sesión creada con éxito:`, data);
      
      const ttl = 1800; // 30 minutos en segundos
      const expiresAt = startTime + (ttl * 1000);
      
      // Devolver respuesta exitosa
      const apiResponse = {
        success: true,
        data: {
          session_id: sessionId,
          visitor_id: visitorId,
          created_at: startTime,
          expires_at: expiresAt,
          ttl: ttl,
          session_url: `/api/visitors/session?session_id=${sessionId}&site_id=${sessionData.site_id}`
        },
        meta: {
          api_version: '1.0',
          server_time: Date.now(),
          processing_time: Date.now() - startTime
        }
      };
      
      console.log(`[POST /api/visitors/session] Respuesta enviada:`, apiResponse);
      return NextResponse.json(apiResponse, { status: 201 });
    } catch (dbError: any) {
      console.error('[POST /api/visitors/session] Error de excepción al insertar:', dbError);
      return errorResponse(`Error interno al insertar en la base de datos: ${dbError.message || 'Error desconocido'}`, 500);
    }
  } catch (error: any) {
    console.error('[POST /api/visitors/session] Error inesperado:', error);
    return errorResponse(`Error interno del servidor: ${error.message}`, 500);
  }
}

/**
 * Obtener datos de una sesión (GET)
 */
export async function GET(request: NextRequest) {
  console.log("[GET /api/visitors/session] Iniciando solicitud GET");
  try {
    // Verificar API key en el encabezado
    const apiKey = request.headers.get('X-SA-API-KEY');
    console.log(`[GET /api/visitors/session] API Key presente: ${!!apiKey}`);
    if (!apiKey) {
      return errorResponse('API Key no proporcionada', 401);
    }
    
    // TODO: Validar API key contra la base de datos
    
    // Obtener parámetros de la URL
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('session_id');
    const siteId = url.searchParams.get('site_id');
    
    console.log(`[GET /api/visitors/session] Parámetros: session_id=${sessionId}, site_id=${siteId}`);
    
    if (!sessionId || !siteId) {
      return errorResponse('Parámetros session_id y site_id son requeridos', 400);
    }
    
    // Validar los parámetros
    const validationResult = GetSessionParamsSchema.safeParse({ session_id: sessionId, site_id: siteId });
    if (!validationResult.success) {
      console.log(`[GET /api/visitors/session] Error de validación:`, validationResult.error.format());
      return errorResponse('Parámetros de URL inválidos', 400, validationResult.error.format());
    }
    
    const startTime = Date.now();
    
    console.log(`[GET /api/visitors/session] Consultando sesión en base de datos`);
    // Consultar la sesión en la base de datos
    const { data: session, error } = await supabaseAdmin
      .from('visitor_sessions')
      .select('*')
      .eq('session_id', sessionId)
      .eq('site_id', siteId)
      .single();
    
    if (error || !session) {
      console.log(`[GET /api/visitors/session] Sesión no encontrada:`, error);
      return errorResponse(`Sesión no encontrada o ha expirado: ${error?.message || ''}`, 404, {
        session_id: sessionId,
        site_id: siteId
      });
    }
    
    console.log(`[GET /api/visitors/session] Sesión encontrada:`, session);
    
    // Consultar eventos relacionados con la sesión
    console.log(`[GET /api/visitors/session] Consultando eventos relacionados`);
    const { data: events, error: eventsError } = await supabaseAdmin
      .from('visitor_events') // Asumiendo que existe una tabla de eventos
      .select('*')
      .eq('session_id', sessionId)
      .order('timestamp', { ascending: true });
    
    if (eventsError) {
      console.log(`[GET /api/visitors/session] Error al consultar eventos:`, eventsError);
    } else {
      console.log(`[GET /api/visitors/session] Eventos encontrados: ${events?.length || 0}`);
    }
    
    // Devolver respuesta exitosa
    const response = {
      success: true,
      data: {
        session_id: session.session_id,
        visitor_id: session.visitor_id,
        site_id: session.site_id,
        url: session.landing_url,
        current_url: session.current_url,
        referrer: session.referrer,
        utm_source: session.utm_source,
        utm_medium: session.utm_medium,
        utm_campaign: session.utm_campaign,
        started_at: session.started_at,
        last_activity_at: session.last_activity_at,
        duration: session.duration,
        page_views: session.page_views,
        active_time: session.active_time,
        idle_time: session.idle_time,
        events: !eventsError ? events : []
      },
      meta: {
        api_version: '1.0',
        server_time: Date.now(),
        processing_time: Date.now() - startTime
      }
    };
    
    console.log(`[GET /api/visitors/session] Respuesta enviada:`, response);
    return NextResponse.json(response);
    
  } catch (error: any) {
    console.error('[GET /api/visitors/session] Error inesperado:', error);
    return errorResponse(`Error interno del servidor: ${error.message}`, 500);
  }
}

/**
 * Actualizar una sesión existente (PUT)
 */
export async function PUT(request: NextRequest) {
  console.log("[PUT /api/visitors/session] Iniciando solicitud PUT");
  try {
    // Verificar API key en el encabezado
    const apiKey = request.headers.get('X-SA-API-KEY');
    console.log(`[PUT /api/visitors/session] API Key presente: ${!!apiKey}`);
    if (!apiKey) {
      return errorResponse('API Key no proporcionada', 401);
    }
    
    // TODO: Validar API key contra la base de datos
    
    // Validar el cuerpo de la solicitud
    console.log(`[PUT /api/visitors/session] Validando cuerpo de solicitud`);
    const body = await request.json();
    console.log(`[PUT /api/visitors/session] Cuerpo recibido:`, body);
    const validationResult = UpdateSessionSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.log(`[PUT /api/visitors/session] Error de validación:`, validationResult.error.format());
      return errorResponse('Datos de solicitud inválidos', 400, validationResult.error.format());
    }
    
    const updateData = validationResult.data;
    console.log(`[PUT /api/visitors/session] Datos validados:`, updateData);
    const startTime = Date.now();
    
    // Verificar que la sesión existe
    console.log(`[PUT /api/visitors/session] Verificando existencia de sesión`);
    const { data: existingSession, error: findError } = await supabaseAdmin
      .from('visitor_sessions')
      .select('*')
      .eq('session_id', updateData.session_id)
      .eq('site_id', updateData.site_id)
      .single();
    
    if (findError || !existingSession) {
      console.log(`[PUT /api/visitors/session] Sesión no encontrada:`, findError);
      return errorResponse('Sesión no encontrada o ha expirado', 404, {
        session_id: updateData.session_id,
        site_id: updateData.site_id
      });
    }
    
    console.log(`[PUT /api/visitors/session] Sesión encontrada:`, existingSession);
    
    // Calcular duración si tenemos last_activity_at
    let duration = existingSession.duration || 0;
    if (updateData.last_activity_at && existingSession.started_at) {
      duration = updateData.last_activity_at - existingSession.started_at;
    }
    
    // Preparar datos para la actualización
    const updates: any = {
      updated_at: new Date().toISOString(),
      is_active: true
    };
    
    if (updateData.last_activity_at) updates.last_activity_at = updateData.last_activity_at;
    if (updateData.current_url) updates.current_url = updateData.current_url;
    if (updateData.page_views) updates.page_views = updateData.page_views;
    if (updateData.active_time) updates.active_time = updateData.active_time;
    if (duration > 0) updates.duration = duration;
    if (updateData.custom_data) updates.custom_data = updateData.custom_data;
    
    console.log(`[PUT /api/visitors/session] Actualizando sesión con:`, updates);
    
    // Actualizar la sesión en la base de datos
    const { data, error } = await supabaseAdmin
      .from('visitor_sessions')
      .update(updates)
      .eq('session_id', updateData.session_id)
      .eq('site_id', updateData.site_id)
      .select()
      .single();
    
    if (error) {
      console.error('[PUT /api/visitors/session] Error al actualizar la sesión:', error);
      return errorResponse(`Error al actualizar la sesión: ${error.message}`, 500);
    }
    
    console.log(`[PUT /api/visitors/session] Sesión actualizada con éxito:`, data);
    
    const ttl = 1800; // 30 minutos en segundos
    const expiresAt = Date.now() + (ttl * 1000);
    
    // Devolver respuesta exitosa
    const response = {
      success: true,
      data: {
        session_id: updateData.session_id,
        updated_at: Date.now(),
        expires_at: expiresAt,
        ttl: ttl
      },
      meta: {
        api_version: '1.0',
        server_time: Date.now(),
        processing_time: Date.now() - startTime
      }
    };
    
    console.log(`[PUT /api/visitors/session] Respuesta enviada:`, response);
    return NextResponse.json(response);
    
  } catch (error: any) {
    console.error('[PUT /api/visitors/session] Error inesperado:', error);
    return errorResponse(`Error interno del servidor: ${error.message}`, 500);
  }
} 