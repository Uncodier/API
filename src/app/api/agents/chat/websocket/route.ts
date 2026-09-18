// Next.js/Vercel runtime configuration for this route
export const runtime = 'edge';
export const preferredRegion = 'auto';
export const maxDuration = 300; // 5 minutes (align with vercel.json and platform limits)
export const dynamic = 'force-dynamic';

// Preventive timeout: close 1 second before Vercel limit
const VERCEL_TIMEOUT_LIMIT_SECONDS = 300; // seconds
const PREVENTIVE_TIMEOUT = (VERCEL_TIMEOUT_LIMIT_SECONDS - 1) * 1000; // milliseconds

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import {
  visitorAuthorizationErrorResponse,
  visitorSessionAuthorizationService
} from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';

// Verificar si estamos ejecutando en un entorno de desarrollo
const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';
console.log(`🌍 Entorno: ${IS_DEVELOPMENT ? 'Desarrollo' : 'Producción'}`);

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para obtener mensajes de una conversación
async function getConversationMessages(conversationId: string, limit: number = 50): Promise<any[]> {
  try {
    if (!isValidUUID(conversationId)) {
      console.error(`ID de conversación no válido: ${conversationId}`);
      return [];
    }
    
    console.log(`🔍 Obteniendo mensajes para la conversación ${conversationId}`);
    
    const { data, error } = await supabaseAdmin
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) {
      console.error('Error al obtener mensajes:', error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontraron mensajes para la conversación ${conversationId}`);
      return [];
    }
    
    // Añadir el campo role a cada mensaje si no existe
    const messagesWithRole = data.map(message => {
      if (!message.role) {
        // Si no tiene role, asignamos un valor por defecto
        // Los roles válidos son: 'assistant', 'user' o 'team_member'
        message.role = 'user'; // valor por defecto
      } else if (!['assistant', 'user', 'team_member'].includes(message.role)) {
        // Si el role existe pero no es uno de los válidos, corregirlo
        message.role = 'user';
      }
      return message;
    });
    
    console.log(`✅ Se encontraron ${messagesWithRole.length} mensajes para la conversación ${conversationId}`);
    return messagesWithRole.reverse(); // Revertir para orden cronológico
  } catch (error) {
    console.error('Error al obtener mensajes de la conversación:', error);
    return [];
  }
}

// Función para crear una nueva conversación si no existe
async function getOrCreateConversation(visitor_id: string, site_id: string, agent_id?: string): Promise<string | null> {
  try {
    if (!isValidUUID(visitor_id) || !isValidUUID(site_id)) {
      console.error(`IDs no válidos: visitor_id=${visitor_id}, site_id=${site_id}`);
      return null;
    }
    
    console.log(`🔍 Buscando conversación activa para el visitante ${visitor_id}`);
    
    // Buscar conversación activa existente
    const { data: existingConv, error: convError } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('visitor_id', visitor_id)
      .eq('site_id', site_id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (convError) {
      console.error('Error al buscar conversación:', convError);
      return null;
    }
    
    // Si existe una conversación activa, devolverla
    if (existingConv && existingConv.length > 0) {
      const conversationId = existingConv[0].id;
      console.log(`✅ Conversación activa encontrada: ${conversationId}`);
      return conversationId;
    }
    
    // Crear nueva conversación
    console.log(`🗣️ Creando nueva conversación para visitante ${visitor_id}`);
    
    const conversationData: any = {
      visitor_id,
      site_id,
      status: 'active',
      title: 'Nueva conversación'
    };
    
    // Añadir agent_id si está presente
    if (agent_id && isValidUUID(agent_id)) {
      conversationData.agent_id = agent_id;
    }
    
    try {
      // Primero verificar que el site_id existe
      const { data: siteData, error: siteError } = await supabaseAdmin
        .from('sites')
        .select('id')
        .eq('id', site_id)
        .single();
      
      if (siteError || !siteData) {
        console.error(`El site_id ${site_id} no existe en la base de datos:`, siteError);
        
        // Buscar algún site válido para usar
        const { data: fallbackSite, error: fallbackError } = await supabaseAdmin
          .from('sites')
          .select('id')
          .limit(1);
        
        if (fallbackError || !fallbackSite || fallbackSite.length === 0) {
          console.error('No se encontró ningún site para usar como fallback:', fallbackError);
          return null;
        }
        
        console.log(`🔄 Usando site_id de fallback: ${fallbackSite[0].id} en lugar de ${site_id}`);
        conversationData.site_id = fallbackSite[0].id;
      }
      
      const { data: newConv, error: createError } = await supabaseAdmin
        .from('conversations')
        .insert([conversationData])
        .select()
        .single();
      
      if (createError) {
        console.error('Error al crear conversación:', createError);
        return null;
      }
      
      console.log(`✅ Nueva conversación creada con ID: ${newConv.id}`);
      return newConv.id;
    } catch (error) {
      console.error('Error al crear conversación:', error);
      return null;
    }
  } catch (error) {
    console.error('Error al obtener/crear conversación:', error);
    return null;
  }
}

// Función para guardar un mensaje en la base de datos
async function saveMessage(conversationId: string, content: string, role: 'user' | 'assistant' | 'system', visitor_id?: string) {
  try {
    console.log(`💬 [saveMessage] Iniciando guardado de mensaje...`);
    console.log(`💬 [saveMessage] Parámetros:`, {
      conversationId,
      content: content?.substring(0, 100) + (content?.length > 100 ? '...' : ''),
      role,
      visitor_id: visitor_id || 'NO_PROPORCIONADO'
    });
    
    if (!isValidUUID(conversationId)) {
      console.error(`❌ [saveMessage] ID de conversación no válido: ${conversationId}`);
      return null;
    }
    
    // Verificar que la conversación existe
    console.log(`🔍 [saveMessage] Verificando que la conversación ${conversationId} existe...`);
    const { data: convCheck, error: convError } = await supabaseAdmin
      .from('conversations')
      .select('id, status')
      .eq('id', conversationId)
      .single();
    
    if (convError || !convCheck) {
      console.error(`❌ [saveMessage] La conversación ${conversationId} no existe:`, convError);
      return null;
    }
    
    console.log(`✅ [saveMessage] Conversación verificada:`, convCheck);
    
    const messageData = {
      conversation_id: conversationId,
      content,
      role,
      visitor_id: role === 'user' ? visitor_id : null
    };
    
    console.log(`📝 [saveMessage] Datos del mensaje a insertar:`, {
      ...messageData,
      content: messageData.content?.substring(0, 100) + (messageData.content?.length > 100 ? '...' : '')
    });
    
    console.log(`🚀 [saveMessage] Insertando en la base de datos...`);
    const { data, error } = await supabaseAdmin
      .from('messages')
      .insert([messageData])
      .select()
      .single();
      
    if (error) {
      console.error(`❌ [saveMessage] Error de Supabase al insertar:`, {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
        fullError: error
      });
      return null;
    }
    
    if (!data) {
      console.error(`❌ [saveMessage] No se recibieron datos después de la inserción`);
      return null;
    }
    
    console.log(`✅ [saveMessage] Mensaje guardado exitosamente con ID: ${data.id}`);
    return data;
  } catch (error) {
    console.error(`❌ [saveMessage] Error inesperado:`, {
      name: (error as Error).name,
      message: (error as Error).message,
      stack: (error as Error).stack
    });
    return null;
  }
}

// Mapa para guardar las conexiones activas y sus suscripciones a canales
const activeConnections = new Map();

export async function GET(req: NextRequest) {
  try {
    // Obtener parámetros de consulta
    const searchParams = req.nextUrl.searchParams;
    let visitor_id = searchParams.get('visitor_id');
    let site_id = searchParams.get('site_id');
    const agent_id = searchParams.get('agent_id');
    const conversation_id = searchParams.get('conversation_id');
    
    console.log(`🔌 Intento de conexión SSE: visitor_id=${visitor_id}, site_id=${site_id}, conversation_id=${conversation_id}`);
    
    if (!site_id || !isValidUUID(site_id)) {
      console.log('❌ ID de sitio no válido:', site_id);
      return new Response('Se requiere un site_id válido', { status: 400 });
    }

    const identity = await visitorSessionAuthorizationService.authorizeBrowserRequest({
      request: req,
      siteId: site_id,
      sessionId: searchParams.get('session_id'),
      conversationId: conversation_id
    });
    if (identity) {
      site_id = identity.siteId;
      visitor_id = identity.visitorId;
    }

    if (!visitor_id || !isValidUUID(visitor_id)) {
      console.log('❌ ID de visitante no válido:', visitor_id);
      return new Response('Se requiere un visitor_id válido', { status: 400 });
    }
    
    // Obtener o crear conversación
    const conversationId = conversation_id && isValidUUID(conversation_id) 
      ? conversation_id 
      : await getOrCreateConversation(visitor_id, site_id, agent_id || undefined);
    
    if (!conversationId) {
      console.log('❌ Error al inicializar la conversación');
      return new Response('Error al inicializar la conversación', { status: 500 });
    }

    // Crear el stream SSE
    const encoder = new TextEncoder();
    let isClosed = false;
    let supabaseChannel: any = null;
    let preventiveTimeoutId: NodeJS.Timeout | null = null;
    
    const stream = new ReadableStream({
      start(controller) {
        const connectionId = uuidv4();
        
        // Función para enviar datos al cliente
        const sendData = (data: any) => {
          if (!isClosed) {
            try {
              const message = `data: ${JSON.stringify(data)}\n\n`;
              controller.enqueue(encoder.encode(message));
            } catch (error) {
              console.error('Error al enviar datos SSE:', error);
            }
          }
        };

        // Función para cerrar la conexión limpiamente
        const closeConnection = async (reason: string) => {
          if (isClosed) return;
          
          const connection = activeConnections.get(connectionId);
          const connectionDuration = connection ? Date.now() - connection.connectionStartTime : 0;
          const durationMinutes = Math.floor(connectionDuration / 60000);
          const durationSeconds = Math.floor((connectionDuration % 60000) / 1000);
          
          console.log(`🔌 Cerrando conexión SSE para visitor_id=${visitor_id}, razón: ${reason}, duración: ${durationMinutes}m ${durationSeconds}s`);
          isClosed = true;
          
          // Enviar mensaje de cierre al cliente
          try {
            sendData({
              type: 'connection_closing',
              payload: { reason, timestamp: Date.now() }
            });
          } catch (error) {
            console.error('Error al enviar mensaje de cierre:', error);
          }
          
          // Limpiar recursos
          if (supabaseChannel) {
            await supabaseChannel.unsubscribe();
          }
          
          if (preventiveTimeoutId) {
            clearTimeout(preventiveTimeoutId);
            preventiveTimeoutId = null;
          }
          
          activeConnections.delete(connectionId);
          
          // Cerrar el controller
          try {
            controller.close();
          } catch (error) {
            console.error('Error al cerrar controller:', error);
          }
        };

        // Configurar timeout preventivo
        preventiveTimeoutId = setTimeout(() => {
          closeConnection('preventive_timeout');
        }, PREVENTIVE_TIMEOUT);

        console.log(`⏰ Timeout preventivo configurado para ${PREVENTIVE_TIMEOUT / 1000} segundos (${Math.floor(PREVENTIVE_TIMEOUT / 60000)} minutos y ${Math.floor((PREVENTIVE_TIMEOUT % 60000) / 1000)} segundos)`);

        // Registrar la conexión activa
        activeConnections.set(connectionId, {
          visitor_id,
          conversationId,
          site_id,
          lastActivity: Date.now(),
          connectionStartTime: Date.now(),
          sendData,
          supabaseChannel: null,
          closeConnection
        });

        console.log(`✅ SSE aceptado para visitor_id=${visitor_id}, conversation_id=${conversationId}`);

        // Enviar mensajes históricos
        const initializeConnection = async () => {
          try {
            // Obtener mensajes históricos
            const messages = await getConversationMessages(conversationId);
            
            // Enviar mensajes históricos al cliente
            sendData({
              type: 'message_history',
              payload: messages
            });

            // Suscribirse a cambios en la tabla de mensajes para esta conversación
            supabaseChannel = supabaseAdmin
              .channel(`chat:${conversationId}`)
              .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'messages',
                filter: `conversation_id=eq.${conversationId}`
              }, (payload) => {
                try {
                  sendData({
                    type: 'new_message',
                    payload: payload.new
                  });
                  console.log(`📤 Mensaje nuevo enviado al cliente: visitor_id=${visitor_id}, message_id=${payload.new.id}`);
                } catch (error) {
                  console.error('Error al enviar mensaje nuevo a través de SSE:', error);
                }
              })
              .subscribe((status) => {
                console.log(`📡 Estado de suscripción a mensajes para conversación ${conversationId}: ${status}`);
                
                // Guardar la referencia al canal en la conexión activa
                const connection = activeConnections.get(connectionId);
                if (connection) {
                  connection.supabaseChannel = supabaseChannel;
                  activeConnections.set(connectionId, connection);
                }
                
                // Enviar confirmación de conexión al cliente
                sendData({
                  type: 'connection_established',
                  payload: {
                    conversation_id: conversationId,
                    status: 'connected'
                  }
                });
              });

            // Configurar heartbeat para mantener la conexión viva
            const heartbeatInterval = setInterval(() => {
              if (!isClosed) {
                sendData({ type: 'ping', timestamp: Date.now() });
                
                // Actualizar timestamp de última actividad
                const connection = activeConnections.get(connectionId);
                if (connection) {
                  connection.lastActivity = Date.now();
                  activeConnections.set(connectionId, connection);
                }
              } else {
                clearInterval(heartbeatInterval);
              }
            }, 30000); // Cada 30 segundos

            // Cleanup cuando se cierra la conexión
            const cleanup = async () => {
              console.log(`🔌 SSE cerrado para visitor_id=${visitor_id}`);
              clearInterval(heartbeatInterval);
              await closeConnection('client_disconnect');
            };

            // Configurar limpieza cuando el cliente cierre la conexión
            req.signal?.addEventListener('abort', cleanup);
            
          } catch (error) {
            console.error('Error al inicializar conexión SSE:', error);
            sendData({
              type: 'error',
              payload: { message: 'Error al inicializar conexión' }
            });
          }
        };

        // Inicializar la conexión
        initializeConnection();
      },
      
      cancel() {
        console.log('🔌 SSE stream cancelado');
        // La función closeConnection se llamará automáticamente a través del cleanup o timeout
      }
    });
    
    // Devolver la respuesta SSE
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    });
  } catch (error) {
    const authorizationResponse = visitorAuthorizationErrorResponse(error);
    if (authorizationResponse) return authorizationResponse;
    console.error('❌ Error al establecer conexión SSE:', error);
    return new Response('Error al establecer conexión SSE', { status: 500 });
  }
}

// Endpoint para enviar mensajes (mantener la lógica existente)
export async function POST(req: NextRequest) {
  console.log('🚀 [POST] Iniciando procesamiento de solicitud');
  
  try {
    // Log de headers
    console.log('📋 [POST] Headers:', {
      'content-type': req.headers.get('content-type'),
      'user-agent': req.headers.get('user-agent'),
      'origin': req.headers.get('origin')
    });
    
    // Intentar parsear el body
    let body;
    try {
      body = await req.json();
      console.log('📦 [POST] Body recibido:', JSON.stringify(body, null, 2));
    } catch (parseError) {
      console.error('❌ [POST] Error al parsear JSON:', parseError);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: { 
            code: 'INVALID_JSON', 
            message: 'El cuerpo de la solicitud no es JSON válido',
            details: (parseError as Error).message 
          } 
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const authorizationPayload = body.type && body.payload ? body.payload : body;
    const query = req.nextUrl.searchParams;
    const browserIdentity = await visitorSessionAuthorizationService.authorizeBrowserRequest({
      request: req,
      siteId: authorizationPayload.site_id || query.get('site_id'),
      sessionId: authorizationPayload.session_id || query.get('session_id'),
      conversationId: authorizationPayload.conversation_id || query.get('conversation_id')
    });
    if (browserIdentity) {
      authorizationPayload.site_id = browserIdentity.siteId;
      authorizationPayload.visitor_id = browserIdentity.visitorId;
      authorizationPayload.lead_id = browserIdentity.leadId;
    }
    
    // Detectar formato del mensaje y nivel de autenticación
    let visitor_id, site_id, agent_id, conversation_id, message, content;
    let user_type: 'visitor' | 'lead' = 'visitor'; // Determinar el tipo de usuario
    let user_id: string = ''; // ID unificado para uso interno
    
    if (body.type && body.payload) {
      // Formato WebSocket legacy
      console.log('🔄 [POST] Detectado formato WebSocket legacy');
      const payload = body.payload;
      
      // Detectar tipo de usuario y asignar ID apropiado
      if (payload.lead_id) {
        user_type = 'lead';
        user_id = payload.lead_id;
        visitor_id = payload.lead_id; // Para compatibilidad con funciones existentes
        console.log('👤 [POST] Usuario autenticado (lead):', user_id);
      } else if (payload.visitor_id) {
        user_type = 'visitor';
        user_id = payload.visitor_id;
        visitor_id = payload.visitor_id;
        console.log('👻 [POST] Usuario anónimo (visitor):', user_id);
      } else {
        console.log('⚠️ [POST] No se encontró lead_id ni visitor_id en payload WebSocket');
      }
      
      site_id = payload.site_id;
      agent_id = payload.agent_id;
      conversation_id = payload.conversation_id;
      message = payload.message || payload.content;
      content = payload.content || payload.message;

      if (browserIdentity) {
        visitor_id = browserIdentity.visitorId;
        user_type = browserIdentity.leadId ? 'lead' : 'visitor';
        user_id = browserIdentity.leadId || browserIdentity.visitorId;
      }
      
      console.log('🔄 [POST] Payload WebSocket mapeado:', {
        type: body.type,
        event: payload.event,
        user_type,
        user_id: user_id || 'FALTANTE',
        site_id: site_id || 'FALTANTE',
        conversation_id: conversation_id || 'FALTANTE',
        hasMessage: !!(message || content)
      });
      
      // Si es solo una suscripción sin mensaje, devolver success
      if (body.type === 'subscribe' && !message && !content) {
        console.log(`✅ [POST] Suscripción WebSocket procesada para ${user_type} (sin mensaje)`);
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              type: 'subscription_ack',
              conversation_id: conversation_id,
              user_type,
              user_id,
              message: `Suscripción procesada para ${user_type}. Usa SSE GET para recibir mensajes en tiempo real.`
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      
    } else {
      // Formato REST directo
      console.log('🔄 [POST] Detectado formato REST');
      
      // Detectar tipo de usuario en formato REST
      if (body.lead_id) {
        user_type = 'lead';
        user_id = body.lead_id;
        visitor_id = body.lead_id;
        console.log('👤 [POST] Usuario autenticado (lead):', user_id);
      } else if (body.visitor_id) {
        user_type = 'visitor';
        user_id = body.visitor_id;
        visitor_id = body.visitor_id;
        console.log('👻 [POST] Usuario anónimo (visitor):', user_id);
      } else {
        console.log('⚠️ [POST] No se encontró lead_id ni visitor_id en formato REST');
      }
      
      site_id = body.site_id;
      agent_id = body.agent_id;
      conversation_id = body.conversation_id;
      message = body.message;
      content = body.content;
    }

    if (browserIdentity) {
      visitor_id = browserIdentity.visitorId;
      site_id = browserIdentity.siteId;
      user_type = browserIdentity.leadId ? 'lead' : 'visitor';
      user_id = browserIdentity.leadId || browserIdentity.visitorId;
    }
    
    console.log('🔍 [POST] Parámetros finales extraídos:', {
      user_type,
      user_id: user_id || 'FALTANTE',
      visitor_id: visitor_id || 'FALTANTE',
      site_id: site_id || 'FALTANTE', 
      agent_id: agent_id || 'NO_PROPORCIONADO',
      conversation_id: conversation_id || 'NO_PROPORCIONADO',
      message: message || 'NO_PROPORCIONADO',
      content: content || 'NO_PROPORCIONADO',
      hasMessage: !!(message || content)
    });
    
    // Validar parámetros requeridos
    if (!user_id) {
      console.error('❌ [POST] user_id faltante (visitor_id o lead_id requerido)');
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: { 
            code: 'MISSING_USER_ID', 
            message: 'Se requiere visitor_id (anónimo) o lead_id (autenticado)' 
          } 
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    if (!isValidUUID(user_id)) {
      console.error(`❌ [POST] ${user_type}_id no válido:`, user_id);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: { 
            code: 'INVALID_USER_ID', 
            message: `${user_type}_id debe ser un UUID válido` 
          } 
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    // Para usuarios autenticados (leads), podemos intentar obtener site_id de la conversación si no se proporciona
    if (!site_id && conversation_id) {
      console.log('🔍 [POST] site_id faltante, obteniendo de la conversación...');
      const { data: convData, error: convError } = await supabaseAdmin
        .from('conversations')
        .select('site_id')
        .eq('id', conversation_id)
        .single();
        
      if (convData && convData.site_id) {
        site_id = convData.site_id;
        console.log('✅ [POST] site_id obtenido de la conversación:', site_id);
      } else {
        console.error('❌ [POST] No se pudo obtener site_id de la conversación:', convError);
      }
    }
    
    if (!site_id) {
      console.error('❌ [POST] site_id faltante');
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: { 
            code: 'MISSING_SITE_ID', 
            message: 'Se requiere site_id o una conversación válida' 
          } 
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    if (!isValidUUID(site_id)) {
      console.error('❌ [POST] site_id no válido:', site_id);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: { 
            code: 'INVALID_SITE_ID', 
            message: 'site_id debe ser un UUID válido' 
          } 
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log(`✅ [POST] Validaciones básicas pasadas para ${user_type}: ${user_id}`);

    // Usar el conversation_id proporcionado o crear uno nuevo
    let conversationId = conversation_id;
    
    if (!conversationId || !isValidUUID(conversationId)) {
      console.log(`🔄 [POST] Creando nueva conversación para ${user_type}...`);
      conversationId = await getOrCreateConversation(visitor_id, site_id, agent_id);
      
      if (!conversationId) {
        console.error('❌ [POST] Error al crear conversación');
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: { 
              code: 'SERVER_ERROR', 
              message: 'Error al inicializar la conversación' 
            } 
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
      console.log(`✅ [POST] Nueva conversación creada para ${user_type}:`, conversationId);
    } else {
      console.log(`✅ [POST] Usando conversación existente para ${user_type}:`, conversationId);
    }

    // Si hay un mensaje para guardar, guardarlo
    if (message || content) {
      const messageContent = message || content;
      console.log(`💬 [POST] Guardando mensaje de ${user_type}:`, {
        conversationId,
        messageContent: messageContent.substring(0, 100) + (messageContent.length > 100 ? '...' : ''),
        role: 'user',
        user_id,
        user_type
      });
      
      const savedMessage = await saveMessage(
        conversationId,
        messageContent,
        'user',
        visitor_id
      );
      
      if (!savedMessage) {
        console.error('❌ [POST] Error al guardar mensaje');
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: { 
              code: 'SERVER_ERROR', 
              message: 'Error al guardar el mensaje' 
            } 
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
      
      console.log(`✅ [POST] Mensaje guardado exitosamente para ${user_type}:`, savedMessage.id);
    } else {
      console.log(`ℹ️ [POST] No hay mensaje para guardar (${user_type})`);
    }
    
    // Obtener mensajes de la conversación
    console.log('📚 [POST] Obteniendo mensajes de la conversación...');
    const messages = await getConversationMessages(conversationId);
    console.log('✅ [POST] Mensajes obtenidos:', messages.length);
    
    console.log(`✅ [POST] Procesamiento completado exitosamente para ${user_type}`);
    
    // Devolver respuesta con los mensajes y datos de la conversación
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          conversation_id: conversationId,
          user_type,
          user_id,
          visitor_id,
          site_id,
          messages
        }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    const authorizationResponse = visitorAuthorizationErrorResponse(error);
    if (authorizationResponse) return authorizationResponse;
    console.error('❌ [POST] Error inesperado:', {
      name: (error as Error).name,
      message: (error as Error).message,
      stack: (error as Error).stack
    });
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor',
          details: (error as Error).message 
        } 
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
} 