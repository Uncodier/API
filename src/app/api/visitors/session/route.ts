import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'
import { v4 as uuidv4 } from 'uuid'
import { extractRequestInfo, extractRequestInfoWithLocation, detectScreenSize } from '@/lib/utils/request-info-extractor'


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
async function validateAndPrepareSessionData(sessionData: any, sessionId: string, visitorId: string, startTime: number, request: NextRequest) {
  try {
    // Verificar campos obligatorios para la tabla visitor_sessions
    const requiredFields = ['site_id'];
    const missingFields = requiredFields.filter(field => {
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

    // Extraer información automáticamente de la petición cuando no se proporcione (incluyendo geolocalización)
    const requestInfo = await extractRequestInfoWithLocation(request);
    console.log(`[validateAndPrepareSessionData] Información extraída de la petición:`, requestInfo);

    // Completar información del dispositivo
    let deviceInfo = sessionData.device;
    if (!deviceInfo || Object.keys(deviceInfo).length === 0) {
      console.log(`[validateAndPrepareSessionData] Completando información del dispositivo automáticamente`);
      deviceInfo = {
        type: requestInfo.device.type,
        screen_size: detectScreenSize(requestInfo.userAgent),
        os: requestInfo.device.os,
        touch_support: requestInfo.device.touch_support
      };
    } else {
      // Completar campos faltantes del dispositivo
      if (!deviceInfo.type) deviceInfo.type = requestInfo.device.type;
      if (!deviceInfo.screen_size) deviceInfo.screen_size = detectScreenSize(requestInfo.userAgent);
      if (!deviceInfo.os) deviceInfo.os = requestInfo.device.os;
      if (deviceInfo.touch_support === undefined) deviceInfo.touch_support = requestInfo.device.touch_support;
    }

    // Completar información del navegador
    let browserInfo = sessionData.browser;
    if (!browserInfo || Object.keys(browserInfo).length === 0) {
      console.log(`[validateAndPrepareSessionData] Completando información del navegador automáticamente`);
      browserInfo = {
        name: requestInfo.browser.name,
        version: requestInfo.browser.version,
        language: requestInfo.browser.language
      };
    } else {
      // Completar campos faltantes del navegador
      if (!browserInfo.name) browserInfo.name = requestInfo.browser.name;
      if (!browserInfo.version) browserInfo.version = requestInfo.browser.version;
      if (!browserInfo.language) browserInfo.language = requestInfo.browser.language;
    }

    // Completar información de ubicación usando geolocalización por IP
    let locationInfo = sessionData.location;
    if (!locationInfo || Object.keys(locationInfo).length === 0) {
      console.log(`[validateAndPrepareSessionData] Completando información de ubicación desde IP: ${requestInfo.ip}`);
      locationInfo = {
        country: requestInfo.location.country,
        region: requestInfo.location.region,
        city: requestInfo.location.city
      };
    } else {
      // Completar campos faltantes de ubicación
      if (!locationInfo.country && requestInfo.location.country) {
        locationInfo.country = requestInfo.location.country;
      }
      if (!locationInfo.region && requestInfo.location.region) {
        locationInfo.region = requestInfo.location.region;
      }
      if (!locationInfo.city && requestInfo.location.city) {
        locationInfo.city = requestInfo.location.city;
      }
    }

    // Preparar datos para la inserción, manejando correctamente tipos de datos
    const preparedData = {
      id: sessionId, // Ahora id es el identificador principal de la sesión
      visitor_id: visitorId, // Mantener visitor_id para compatibilidad con DB
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
      device: deviceInfo || null,
      browser: browserInfo || null,
      location: locationInfo || null,
      previous_session_id: sessionData.previous_session_id || null,
      performance: sessionData.performance || null,
      consent: sessionData.consent || null,
      is_active: true,
    };

    console.log(`[validateAndPrepareSessionData] Datos preparados para inserción:`, {
      ...preparedData,
      device: deviceInfo,
      browser: browserInfo,
      location: locationInfo
    });

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
  id: z.string().optional(),
  fingerprint: z.string().optional(),
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
  }, { 
    status
  });
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
    let visitorId = sessionData.id || uuidv4();
    const startTime = Date.now();
    let previousSessionFromFingerprint = null;
    
    // Si se proporciona un fingerprint, buscar primero una sesión activa con este fingerprint
    if (sessionData.fingerprint) {
      console.log(`[POST /api/visitors/session] Buscando sesión activa con fingerprint: ${sessionData.fingerprint}`);
      
      // Primero buscar un visitante existente con el fingerprint
      const { data: existingVisitorByFingerprint, error: fingerprintSearchError } = await supabaseAdmin
        .from('visitors')
        .select('id')
        .eq('fingerprint', sessionData.fingerprint)
        .single();
      
      if (existingVisitorByFingerprint && !fingerprintSearchError) {
        console.log(`[POST /api/visitors/session] Visitante encontrado con fingerprint: ${sessionData.fingerprint}, id: ${existingVisitorByFingerprint.id}`);
        visitorId = existingVisitorByFingerprint.id;
        
        // Verificar si hay una sesión activa para este visitante
        const { data: activeSession, error: activeSessionError } = await supabaseAdmin
          .from('visitor_sessions')
          .select('*')
          .eq('visitor_id', visitorId)
          .eq('site_id', sessionData.site_id)
          .eq('is_active', true)
          .order('last_activity_at', { ascending: false })
          .limit(1)
          .single();
        
        // Si encontramos una sesión activa, la cerraremos y crearemos una nueva
        if (activeSession && !activeSessionError) {
          console.log(`[POST /api/visitors/session] Sesión activa encontrada, cerrando para crear nueva: ${activeSession.id}`);
          
          // Guardar la sesión activa como previous_session_id
          previousSessionFromFingerprint = activeSession.id;
          
          // Calcular idle_time para la sesión anterior
          const sessionDuration = startTime - activeSession.started_at;
          const idleTime = activeSession.active_time 
            ? sessionDuration - activeSession.active_time
            : sessionDuration;
          
          console.log(`[POST /api/visitors/session] Calculando idle_time para sesión ${activeSession.id}: duration=${sessionDuration}, active_time=${activeSession.active_time}, idle_time=${idleTime}`);
          
          // Cerrar la sesión activa encontrada
          const { error: closeError } = await supabaseAdmin
            .from('visitor_sessions')
            .update({
              is_active: false,
              duration: sessionDuration,
              idle_time: idleTime,
              exit_type: 'new_session',
              updated_at: new Date().toISOString()
            })
            .eq('id', activeSession.id);
          
          if (closeError) {
            console.error(`[POST /api/visitors/session] Error al cerrar sesión encontrada por fingerprint:`, closeError);
          } else {
            console.log(`[POST /api/visitors/session] Sesión encontrada por fingerprint cerrada exitosamente`);
          }
          
          // Continuar con la creación de una nueva sesión con previous_session_id establecido
          // No retornamos aquí, dejamos que continúe el flujo normal
          console.log(`[POST /api/visitors/session] Continuando con creación de nueva sesión...`);
        }
      } else {
        console.log(`[POST /api/visitors/session] No se encontró visitante con fingerprint: ${sessionData.fingerprint}`);
      }
    }
    
    console.log(`[POST /api/visitors/session] Generados sessionId: ${sessionId}, visitorId: ${visitorId}`);
    
    // Validar y preparar datos para la base de datos
    const validation = await validateAndPrepareSessionData(sessionData, sessionId, visitorId, startTime, request);
    if (!validation.valid || !validation.data) {
      console.error(`[POST /api/visitors/session] Error de validación de datos para DB:`, validation.error);
      return errorResponse(`Error al preparar datos: ${validation.error}`);
    }
    
    const newSession = validation.data;
    
    try {
      // Primero, verificar si el visitante ya existe y buscar su última sesión
      console.log(`[POST /api/visitors/session] Verificando si el visitante existe en la base de datos...`);
      const { data: existingVisitor, error: visitorCheckError } = await supabaseAdmin
        .from('visitors')
        .select('id')
        .eq('id', visitorId)
        .single();

      let previousSessionId = null;
      
      // Si el visitante ya existe, buscar su última sesión para cerrarla y establecer previous_session_id
      if (existingVisitor && !visitorCheckError) {
        console.log(`[POST /api/visitors/session] Visitante existe, buscando última sesión activa...`);
        
        // Buscar la última sesión del visitante (activa o no)
        const { data: lastSession, error: lastSessionError } = await supabaseAdmin
          .from('visitor_sessions')
          .select('id, is_active')
          .eq('visitor_id', visitorId)
          .eq('site_id', sessionData.site_id)
          .order('started_at', { ascending: false })
          .limit(1)
          .single();

        if (lastSession && !lastSessionError) {
          console.log(`[POST /api/visitors/session] Última sesión encontrada: ${lastSession.id}, activa: ${lastSession.is_active}`);
          previousSessionId = lastSession.id;
          
          // Si la sesión anterior está activa, cerrarla
          if (lastSession.is_active) {
            console.log(`[POST /api/visitors/session] Cerrando sesión anterior: ${lastSession.id}`);
            
            // Primero obtener los datos completos de la sesión para calcular idle_time
            const { data: fullLastSession, error: fullSessionError } = await supabaseAdmin
              .from('visitor_sessions')
              .select('started_at, active_time')
              .eq('id', lastSession.id)
              .single();
            
            if (fullLastSession && !fullSessionError) {
              // Calcular idle_time para la sesión anterior
              const sessionDuration = startTime - fullLastSession.started_at;
              const idleTime = fullLastSession.active_time 
                ? sessionDuration - fullLastSession.active_time
                : sessionDuration;
              
              console.log(`[POST /api/visitors/session] Calculando idle_time para sesión anterior ${lastSession.id}: duration=${sessionDuration}, active_time=${fullLastSession.active_time}, idle_time=${idleTime}`);
              
              const { error: closeSessionError } = await supabaseAdmin
                .from('visitor_sessions')
                .update({
                  is_active: false,
                  duration: sessionDuration,
                  idle_time: idleTime,
                  exit_type: 'new_session',
                  updated_at: new Date().toISOString()
                })
                .eq('id', lastSession.id);
              
              if (closeSessionError) {
                console.error(`[POST /api/visitors/session] Error al cerrar sesión anterior:`, closeSessionError);
              } else {
                console.log(`[POST /api/visitors/session] Sesión anterior cerrada exitosamente con idle_time calculado`);
              }
            } else {
              console.error(`[POST /api/visitors/session] Error al obtener datos completos de la sesión anterior:`, fullSessionError);
              
              // Fallback: cerrar sin calcular idle_time
              const { error: closeSessionError } = await supabaseAdmin
                .from('visitor_sessions')
                .update({
                  is_active: false,
                  exit_type: 'new_session',
                  updated_at: new Date().toISOString()
                })
                .eq('id', lastSession.id);
              
              if (closeSessionError) {
                console.error(`[POST /api/visitors/session] Error al cerrar sesión anterior (fallback):`, closeSessionError);
              } else {
                console.log(`[POST /api/visitors/session] Sesión anterior cerrada exitosamente (fallback sin idle_time)`);
                             }
             }
           }
        } else {
          console.log(`[POST /api/visitors/session] No se encontró sesión anterior para el visitante`);
        }
      }
      
      // Establecer el previous_session_id en los datos de la nueva sesión
      // Priorizar la sesión encontrada por fingerprint sobre la última sesión del visitante
      const finalPreviousSessionId = previousSessionFromFingerprint || previousSessionId;
      if (finalPreviousSessionId) {
        newSession.previous_session_id = finalPreviousSessionId;
        console.log(`[POST /api/visitors/session] Estableciendo previous_session_id: ${finalPreviousSessionId} (fuente: ${previousSessionFromFingerprint ? 'fingerprint' : 'última sesión'})`);
      }
      
      // Si el visitante no existe, crearlo primero
      if (!existingVisitor || visitorCheckError) {
        console.log(`[POST /api/visitors/session] Visitante no existe, creando nuevo visitante con ID: ${visitorId}`);
        
        // Extraer información de la petición para completar datos del visitante (incluyendo geolocalización)
        const requestInfo = await extractRequestInfoWithLocation(request);
        
        // Nota: La información de dispositivo, navegador y ubicación se guarda solo en visitor_sessions
        // ya que un visitante puede tener múltiples sesiones desde diferentes dispositivos/ubicaciones

        // Crear nuevo registro de visitante
        const newVisitor = {
          id: visitorId,
          fingerprint: sessionData.fingerprint || null,
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
          is_identified: false
        };
        
        console.log(`[POST /api/visitors/session] Insertando nuevo visitante:`, newVisitor);
        
        const { error: visitorInsertError } = await supabaseAdmin
          .from('visitors')
          .insert([newVisitor]);
        
        if (visitorInsertError) {
          console.error(`[POST /api/visitors/session] Error al crear visitante:`, visitorInsertError);
          return errorResponse(`Error al crear visitante: ${visitorInsertError.message || 'Error desconocido'}`);
        }
        
        console.log(`[POST /api/visitors/session] Visitante creado con éxito`);
        console.log(`[POST /api/visitors/session] Información del visitante guardada (device, browser, location se guardan solo en visitor_sessions)`);
      } else {
        console.log(`[POST /api/visitors/session] Visitante ya existe, actualizando datos...`);
        
        // Actualizar visitante existente incrementando total_sessions
        const { error: visitorUpdateError } = await supabaseAdmin
          .rpc('increment_visitor_sessions', {
            visitor_id: visitorId,
            last_seen_timestamp: startTime
          });
        
        if (visitorUpdateError) {
          console.error(`[POST /api/visitors/session] Error al actualizar visitante:`, visitorUpdateError);
          
          // Fallback: usar actualización directa con valor calculado
          console.log(`[POST /api/visitors/session] Intentando actualización con fallback...`);
          
          // Obtener el valor actual y incrementarlo
          const { data: currentVisitor, error: fetchError } = await supabaseAdmin
            .from('visitors')
            .select('total_sessions')
            .eq('id', visitorId)
            .single();
          
          if (!fetchError && currentVisitor) {
            const { error: fallbackUpdateError } = await supabaseAdmin
              .from('visitors')
              .update({
                last_seen_at: startTime,
                total_sessions: (currentVisitor.total_sessions || 0) + 1
              })
              .eq('id', visitorId);
            
            if (fallbackUpdateError) {
              console.error(`[POST /api/visitors/session] Error en actualización fallback:`, fallbackUpdateError);
            }
          }
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
        return errorResponse(`Error al crear la sesión: ${error.message || 'Error desconocido en la base de datos'}`);
      }
      
      if (!data) {
        console.error('[POST /api/visitors/session] No se recibieron datos aunque no hubo error');
        return errorResponse('Error al crear la sesión: No se recibieron datos de confirmación');
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
          fingerprint: sessionData.fingerprint || null,
          id: visitorId,
          lead_id: null,
          created_at: startTime,
          expires_at: expiresAt,
          ttl: ttl,
          session_url: `/api/visitors/session?session_id=${sessionId}&site_id=${sessionData.site_id}`,
          is_new_session: true
        },
        meta: {
          api_version: '1.0',
          server_time: Date.now(),
          processing_time: Date.now() - startTime
        }
      };
      
      console.log(`[POST /api/visitors/session] Respuesta enviada:`, apiResponse);
      return NextResponse.json(apiResponse, { 
        status: 201
      });
    } catch (dbError: any) {
      console.error('[POST /api/visitors/session] Error de excepción al insertar:', dbError);
      return errorResponse(`Error interno al insertar en la base de datos: ${dbError.message || 'Error desconocido'}`);
    }
  } catch (error: any) {
    console.error('[POST /api/visitors/session] Error inesperado:', error);
    return errorResponse(`Error interno del servidor: ${error.message}`);
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
      .select('*, visitors(fingerprint)')
      .eq('id', sessionId)
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
        session_id: session.id,
        visitor_id: session.visitor_id,
        fingerprint: session.visitors?.fingerprint || null,
        id: session.visitor_id,
        lead_id: session.lead_id,
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
    return errorResponse(`Error interno del servidor: ${error.message}`);
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
      .select('*, visitors(fingerprint)')
      .eq('id', updateData.session_id)
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
      .eq('id', updateData.session_id)
      .eq('site_id', updateData.site_id)
      .select()
      .single();
    
    if (error) {
      console.error('[PUT /api/visitors/session] Error al actualizar la sesión:', error);
      return errorResponse(`Error al actualizar la sesión: ${error.message}`);
    }
    
    console.log(`[PUT /api/visitors/session] Sesión actualizada con éxito:`, data);
    
    const ttl = 1800; // 30 minutos en segundos
    const expiresAt = Date.now() + (ttl * 1000);
    
    // Devolver respuesta exitosa
    const response = {
      success: true,
      data: {
        session_id: updateData.session_id,
        visitor_id: existingSession.visitor_id,
        fingerprint: existingSession.visitors?.fingerprint || null,
        id: existingSession.visitor_id,
        lead_id: existingSession.lead_id,
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
    return errorResponse(`Error interno del servidor: ${error.message}`);
  }
}
