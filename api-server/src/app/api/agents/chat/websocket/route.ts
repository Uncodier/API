import { NextRequest } from 'next/server';
 import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Verificar si estamos ejecutando en un entorno de desarrollo
const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';
console.log(`🌍 Entorno: ${IS_DEVELOPMENT ? 'Desarrollo' : 'Producción'}`);

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para actualizar el estado de la sesión del visitante
async function updateVisitorSessionStatus(visitor_id: string, status: 'active' | 'inactive'): Promise<boolean> {
  try {
    if (!isValidUUID(visitor_id)) {
      console.error(`ID de visitante no válido: ${visitor_id}`);
      return false;
    }
    
    console.log(`🔄 Actualizando estado de sesión para el visitante ${visitor_id} a: ${status}`);
    
    // Buscar la sesión activa del visitante
    const { data: sessionData, error: sessionError } = await supabaseAdmin
      .from('visitor_sessions')
      .select('id, visitor_id, site_id')
      .eq('visitor_id', visitor_id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (sessionError) {
      console.error('Error al buscar la sesión del visitante:', sessionError);
      return false;
    }
    
    // Si no hay sesión activa y queremos activar, crear una nueva
    if ((!sessionData || sessionData.length === 0) && status === 'active') {
      console.log(`🆕 No se encontró sesión activa para ${visitor_id}, creando nueva sesión...`);
      
      // Primero verificar que el visitante existe
      const { data: visitorData, error: visitorError } = await supabaseAdmin
        .from('visitors')
        .select('id')
        .eq('id', visitor_id)
        .single();
        
      if (visitorError || !visitorData) {
        console.error(`❌ El visitante ${visitor_id} no existe en la base de datos:`, visitorError);
        return false;
      }
      
      // Buscar un site válido para usar
      const { data: siteData, error: siteError } = await supabaseAdmin
        .from('sites')
        .select('id')
        .limit(1);
        
      if (siteError || !siteData || siteData.length === 0) {
        console.error('❌ No se pudo encontrar un site para la sesión:', siteError);
        return false;
      }
      
      const site_id = siteData[0].id;
      
      // Crear nueva sesión
      const { data: newSession, error: createError } = await supabaseAdmin
        .from('visitor_sessions')
        .insert([{
          visitor_id,
          site_id,
          is_active: true,
          session_data: {}, // Objeto vacío por defecto
        }])
        .select()
        .single();
        
      if (createError) {
        console.error('❌ Error al crear nueva sesión de visitante:', createError);
        return false;
      }
      
      console.log(`✅ Nueva sesión creada para ${visitor_id} con ID: ${newSession.id}`);
      return true;
    } else if (!sessionData || sessionData.length === 0) {
      // Si no hay sesión activa y queremos desactivar, no hay nada que hacer
      console.log(`⚠️ No se encontró sesión activa para ${visitor_id}`);
      return true; // Considerar como éxito ya que ya está inactivo
    }
    
    // Actualizar la sesión existente
    const sessionId = sessionData[0].id;
    
    // Actualizar el estado de la sesión
    const { error: updateError } = await supabaseAdmin
      .from('visitor_sessions')
      .update({ is_active: status === 'active' })
      .eq('id', sessionId);
    
    if (updateError) {
      console.error(`❌ Error al actualizar el estado de la sesión ${sessionId}:`, updateError);
      return false;
    }
    
    console.log(`✅ Estado de sesión para el visitante ${visitor_id} actualizado a: ${status}`);
    return true;
  } catch (error) {
    console.error('❌ Error al actualizar el estado de la sesión del visitante:', error);
    return false;
  }
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

export async function GET(req: NextRequest) {
  // Verificar si la solicitud es un WebSocket
  const { headers } = req;
  const upgradeHeader = headers.get('connection');
  
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'upgrade') {
    console.log('❌ Esta solicitud no es una conexión WebSocket:', req.method, req.nextUrl.pathname);
    return new Response('Esta ruta requiere una conexión WebSocket', { 
      status: 426,
      headers: {
        'Content-Type': 'text/plain',
        'Upgrade': 'websocket',
        'Connection': 'Upgrade'
      }
    });
  }
  
  try {
    // Obtener parámetros de consulta
    const searchParams = req.nextUrl.searchParams;
    const visitor_id = searchParams.get('visitor_id');
    const site_id = searchParams.get('site_id');
    const agent_id = searchParams.get('agent_id');
    const conversation_id = searchParams.get('conversation_id');
    
    console.log(`🔌 Intento de conexión WebSocket: visitor_id=${visitor_id}, site_id=${site_id}, conversation_id=${conversation_id}`);
    
    // Validar parámetros requeridos
    if (!visitor_id || !isValidUUID(visitor_id)) {
      console.log('❌ ID de visitante no válido:', visitor_id);
      return new Response('Se requiere un visitor_id válido', { status: 400 });
    }
    
    if (!site_id || !isValidUUID(site_id)) {
      console.log('❌ ID de sitio no válido:', site_id);
      return new Response('Se requiere un site_id válido', { status: 400 });
    }
    
    // Actualizar estado de sesión del visitante a activo
    await updateVisitorSessionStatus(visitor_id, 'active');
    
    // Obtener o crear conversación
    const conversationId = conversation_id && isValidUUID(conversation_id) 
      ? conversation_id 
      : await getOrCreateConversation(visitor_id, site_id, agent_id || undefined);
    
    if (!conversationId) {
      console.log('❌ Error al inicializar la conversación');
      return new Response('Error al inicializar la conversación', { status: 500 });
    }
    
    // Si estamos en desarrollo, redirigir al servidor WebSocket dedicado
    if (IS_DEVELOPMENT) {
      // Construir la URL del servidor WebSocket dedicado
      const host = req.headers.get('host') || 'localhost:3001';
      const hostname = host.split(':')[0]; // Obtener solo el hostname sin el puerto
      
      // Crear una URL de redirección al servidor WebSocket dedicado
      const wsServerUrl = `http://${hostname}:3002/ws?visitor_id=${visitor_id}&site_id=${site_id}&conversation_id=${conversationId}`;
      console.log(`🔄 Redirigiendo a servidor WebSocket dedicado: ${wsServerUrl}`);
      
      // Devolver una redirección 307 (temporal) al servidor WebSocket
      return Response.redirect(wsServerUrl, 307);
    }
    
    // Para producción también redirigimos a un servidor WebSocket dedicado
    // La URL en producción dependerá de la configuración del entorno
    const wsHost = process.env.WS_SERVER_HOST || req.headers.get('host');
    const wsPort = process.env.WS_SERVER_PORT || '8080'; // Puerto predeterminado para el servidor WebSocket en producción
    
    // Construir la URL de redirección para el entorno de producción
    const wsServerUrl = `https://${wsHost}/ws?visitor_id=${visitor_id}&site_id=${site_id}&conversation_id=${conversationId}`;
    console.log(`🔄 [PROD] Redirigiendo a servidor WebSocket dedicado: ${wsServerUrl}`);
    
    // Devolver una redirección 307 (temporal) al servidor WebSocket de producción
    return Response.redirect(wsServerUrl, 307);
  } catch (error) {
    console.error('❌ Error al establecer conexión WebSocket:', error);
    return new Response('Error al establecer conexión WebSocket', { status: 500 });
  }
}

// Endpoint para obtener mensajes HTTP (fallback cuando WebSocket no está disponible)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { visitor_id, site_id, agent_id, conversation_id } = body;
    
    // Validar parámetros requeridos
    if (!visitor_id || !isValidUUID(visitor_id)) {
      return new Response(
        JSON.stringify({ success: false, error: { code: 'INVALID_REQUEST', message: 'Se requiere un visitor_id válido' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    if (!site_id || !isValidUUID(site_id)) {
      return new Response(
        JSON.stringify({ success: false, error: { code: 'INVALID_REQUEST', message: 'Se requiere un site_id válido' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    // Actualizar estado de sesión del visitante a activo
    await updateVisitorSessionStatus(visitor_id, 'active');
    
    // Usar el conversation_id proporcionado o crear uno nuevo
    let conversationId = conversation_id;
    
    if (!conversationId || !isValidUUID(conversationId)) {
      conversationId = await getOrCreateConversation(visitor_id, site_id, agent_id);
      
      if (!conversationId) {
        return new Response(
          JSON.stringify({ success: false, error: { code: 'SERVER_ERROR', message: 'Error al inicializar la conversación' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
    
    // Obtener mensajes de la conversación (ya incluye el role gracias a la modificación en getConversationMessages)
    const messages = await getConversationMessages(conversationId);
    
    // Devolver respuesta con los mensajes y datos de la conversación
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          conversation_id: conversationId,
          visitor_id,
          site_id,
          messages
        }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error al procesar la solicitud HTTP:', error);
    return new Response(
      JSON.stringify({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Error interno del servidor' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
} 