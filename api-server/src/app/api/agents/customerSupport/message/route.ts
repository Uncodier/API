import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para encontrar un agente de soporte al cliente activo para un sitio
async function findActiveCustomerSupportAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente de soporte al cliente activo para el sitio: ${siteId}`);
    
    // Solo buscamos por site_id, role y status
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', 'Customer Support')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error al buscar agente de soporte al cliente:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente de soporte al cliente activo para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente de soporte al cliente encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error al buscar agente de soporte al cliente:', error);
    return null;
  }
}

// Función para obtener información completa del agente
async function getAgentInfo(agentId: string): Promise<{ user_id: string, site_id?: string } | null> {
  try {
    if (!isValidUUID(agentId)) {
      console.error(`ID de agente no válido: ${agentId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información del agente: ${agentId}`);
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id, site_id')
      .eq('id', agentId)
      .single();
    
    if (error) {
      console.error('Error al obtener información del agente:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ No se encontró el agente con ID: ${agentId}`);
      return null;
    }
    
    console.log(`✅ Información del agente recuperada: user_id=${data.user_id}, site_id=${data.site_id || 'N/A'}`);
    
    return {
      user_id: data.user_id,
      site_id: data.site_id
    };
  } catch (error) {
    console.error('Error al obtener información del agente:', error);
    return null;
  }
}

// Inicializar el agente y obtener el servicio de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Función para obtener el UUID de la base de datos para un comando
async function getCommandDbUuid(internalId: string): Promise<string | null> {
  try {
    // Intentar obtener el comando
    const command = await commandService.getCommandById(internalId);
    
    // Verificar metadata
    if (command && command.metadata && command.metadata.dbUuid) {
      if (isValidUUID(command.metadata.dbUuid)) {
        console.log(`🔑 UUID encontrado en metadata: ${command.metadata.dbUuid}`);
        return command.metadata.dbUuid;
      }
    }
    
    // Buscar en el mapa de traducción interno del CommandService
    // (esta es una solución de respaldo)
    try {
      // Esto es un hack para acceder al mapa de traducción interno
      // @ts-ignore - Accediendo a propiedades internas
      const idMap = (commandService as any).idTranslationMap;
      if (idMap && idMap.get && idMap.get(internalId)) {
        const mappedId = idMap.get(internalId);
        if (isValidUUID(mappedId)) {
          console.log(`🔑 UUID encontrado en mapa interno: ${mappedId}`);
          return mappedId;
        }
      }
    } catch (err) {
      console.log('No se pudo acceder al mapa de traducción interno');
    }
    
    // Buscar en la base de datos directamente por algún campo que pueda relacionarse
    if (command) {
      const { data, error } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('task', command.task)
        .eq('user_id', command.user_id)
        .eq('status', command.status)
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (!error && data && data.length > 0) {
        console.log(`🔑 UUID encontrado en búsqueda directa: ${data[0].id}`);
        return data[0].id;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error al obtener UUID de base de datos:', error);
    return null;
  }
}

// Función para esperar a que un comando se complete
async function waitForCommandCompletion(commandId: string, maxAttempts = 60, delayMs = 1000) {
  let executedCommand = null;
  let attempts = 0;
  let dbUuid: string | null = null;
  
  console.log(`⏳ Esperando a que se complete el comando ${commandId}...`);
  
  // Crear una promesa que se resuelve cuando el comando se completa o se agota el tiempo
  return new Promise<{command: any, dbUuid: string | null, completed: boolean}>((resolve) => {
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        executedCommand = await commandService.getCommandById(commandId);
        
        if (!executedCommand) {
          console.log(`⚠️ No se pudo encontrar el comando ${commandId}`);
          clearInterval(checkInterval);
          resolve({command: null, dbUuid: null, completed: false});
          return;
        }
        
        // Guardar el UUID de la base de datos si está disponible
        if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
          dbUuid = executedCommand.metadata.dbUuid as string;
          console.log(`🔑 UUID de base de datos encontrado en metadata: ${dbUuid}`);
        }
        
        if (executedCommand.status === 'completed' || executedCommand.status === 'failed') {
          console.log(`✅ Comando ${commandId} completado con estado: ${executedCommand.status}`);
          
          // Intentar obtener el UUID de la base de datos si aún no lo tenemos
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido después de completar: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: executedCommand.status === 'completed'});
          return;
        }
        
        console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
          
          // Último intento de obtener el UUID
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido antes de timeout: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: false});
        }
      } catch (error) {
        console.error(`Error al verificar estado del comando ${commandId}:`, error);
        clearInterval(checkInterval);
        resolve({command: null, dbUuid: null, completed: false});
      }
    }, delayMs);
  });
}

// Función para guardar mensajes en la base de datos
async function saveMessages(userId: string, userMessage: string, assistantMessage: string, conversationId?: string, conversationTitle?: string, leadId?: string, visitorId?: string, agentId?: string, siteId?: string, commandId?: string) {
  try {
    console.log(`💾 Guardando mensajes con: user_id=${userId}, agent_id=${agentId || 'N/A'}, site_id=${siteId || 'N/A'}, lead_id=${leadId || 'N/A'}, visitor_id=${visitorId || 'N/A'}, command_id=${commandId || 'N/A'}`);
    
    let effectiveConversationId: string | undefined = conversationId;
    
    // Verificar si tenemos un ID de conversación
    if (conversationId) {
      // Verificamos primero que la conversación realmente existe en la base de datos
      console.log(`🔍 Verificando existencia de conversación: ${conversationId}`);
      const { data: existingConversation, error: checkError } = await supabaseAdmin
        .from('conversations')
        .select('id, user_id, lead_id, visitor_id, agent_id, site_id')
        .eq('id', conversationId)
        .single();
      
      if (checkError || !existingConversation) {
        console.log(`⚠️ Conversación no encontrada en la base de datos, creando nueva: ${conversationId}`);
        // Si la conversación no existe aunque tengamos un ID, crearemos una nueva
        effectiveConversationId = undefined;
      } else {
        console.log(`✅ Conversación existente confirmada: ${conversationId}`);
        console.log(`📊 Datos de conversación existente:`, JSON.stringify(existingConversation));
      }
    }
    
    // Crear una nueva conversación si no existe
    if (!effectiveConversationId) {
      // Crear una nueva conversación
      const conversationData: any = {
        // Añadir user_id obligatoriamente
        user_id: userId
      };
      
      // Añadir visitor_id, agent_id y site_id si están presentes
      if (visitorId) conversationData.visitor_id = visitorId;
      if (agentId) conversationData.agent_id = agentId;
      if (siteId) conversationData.site_id = siteId;
      
      // Añadir lead_id si está presente (independientemente de si hay agentId o no)
      if (leadId) {
        conversationData.lead_id = leadId;
        console.log(`✅ Agregando lead_id ${leadId} a la nueva conversación`);
      }
      
      // Añadir el título si está presente
      if (conversationTitle) conversationData.title = conversationTitle;
      
      console.log(`🗣️ Creando nueva conversación con datos:`, JSON.stringify(conversationData));
      
      const { data: conversation, error: convError } = await supabaseAdmin
        .from('conversations')
        .insert([conversationData])
        .select()
        .single();
      
      if (convError) {
        console.error('Error al crear conversación:', convError);
        return null;
      }
      
      effectiveConversationId = conversation.id;
      console.log(`🗣️ Nueva conversación creada con ID: ${effectiveConversationId}`);
    } else if (conversationTitle || siteId || leadId) {
      // Actualizar la conversación existente si se proporciona un nuevo título, site_id o lead_id
      const updateData: any = {};
      if (conversationTitle) updateData.title = conversationTitle;
      if (siteId) updateData.site_id = siteId;
      if (leadId) updateData.lead_id = leadId;
      
      console.log(`✏️ Actualizando conversación: ${effectiveConversationId} con:`, JSON.stringify(updateData));
      
      const { error: updateError } = await supabaseAdmin
        .from('conversations')
        .update(updateData)
        .eq('id', effectiveConversationId);
      
      if (updateError) {
        console.error('Error al actualizar conversación:', updateError);
        // No fallamos toda la operación si solo falla la actualización
        console.log('Continuando con el guardado de mensajes...');
      } else {
        if (conversationTitle) {
          console.log(`✏️ Título de conversación actualizado: "${conversationTitle}"`);
        }
        if (siteId) {
          console.log(`🔗 Site ID de conversación actualizado: "${siteId}"`);
        }
        if (leadId) {
          console.log(`👤 Lead ID de conversación actualizado: "${leadId}"`);
        }
      }
    }
    
    // Guardar el mensaje del usuario
    const userMessageObj: any = {
      conversation_id: effectiveConversationId,
      user_id: userId,
      content: userMessage,
      role: 'user'
    };
    
    // Agregar visitor_id si está presente
    if (visitorId) userMessageObj.visitor_id = visitorId;
    
    // Agregar lead_id si está presente (independientemente del agentId)
    if (leadId) {
      userMessageObj.lead_id = leadId;
      console.log(`👤 Agregando lead_id ${leadId} al mensaje del usuario`);
    }
    
    // Agregar agent_id si está presente
    if (agentId) userMessageObj.agent_id = agentId;
    
    // Agregar command_id si está presente y es un UUID válido
    if (commandId && isValidUUID(commandId)) {
      userMessageObj.command_id = commandId;
    }
    
    console.log(`💬 Guardando mensaje de usuario para conversación: ${effectiveConversationId}`);
    
    const { data: savedUserMessage, error: userMsgError } = await supabaseAdmin
      .from('messages')
      .insert([userMessageObj])
      .select()
      .single();
    
    if (userMsgError) {
      console.error('Error al guardar mensaje del usuario:', userMsgError);
      return null;
    }
    
    console.log(`💾 Mensaje del usuario guardado con ID: ${savedUserMessage.id}`);
    
    // Guardar el mensaje del asistente
    const assistantMessageObj: any = {
      conversation_id: effectiveConversationId,
      user_id: null, // Agente no es usuario
      content: assistantMessage,
      role: 'assistant'
    };
    
    // Agregar visitor_id si está presente
    if (visitorId) assistantMessageObj.visitor_id = visitorId;
    
    // Agregar lead_id si está presente (independientemente del agentId)
    if (leadId) {
      assistantMessageObj.lead_id = leadId;
      console.log(`👤 Agregando lead_id ${leadId} al mensaje del asistente`);
    }
    
    // Agregar agent_id si está presente
    if (agentId) assistantMessageObj.agent_id = agentId;
    
    // Agregar command_id si está presente y es un UUID válido
    if (commandId && isValidUUID(commandId)) {
      assistantMessageObj.command_id = commandId;
    }
    
    console.log(`💬 Guardando mensaje de asistente para conversación: ${effectiveConversationId}`);
    
    const { data: savedAssistantMessage, error: assistantMsgError } = await supabaseAdmin
      .from('messages')
      .insert([assistantMessageObj])
      .select()
      .single();
    
    if (assistantMsgError) {
      console.error('Error al guardar mensaje del asistente:', assistantMsgError);
      return null;
    }
    
    console.log(`💾 Mensaje del asistente guardado con ID: ${savedAssistantMessage.id}`);
    
    // Verificamos que la conversación esté asociada correctamente
    const { data: finalConversation, error: finalCheckError } = await supabaseAdmin
      .from('conversations')
      .select('id, user_id, lead_id, visitor_id, agent_id, site_id, title')
      .eq('id', effectiveConversationId)
      .single();
      
    if (!finalCheckError && finalConversation) {
      console.log(`✅ Verificación final de conversación: ${JSON.stringify(finalConversation)}`);
    } else {
      console.error(`❌ Error al verificar conversación final:`, finalCheckError);
    }
    
    return {
      conversationId: effectiveConversationId,
      userMessageId: savedUserMessage.id,
      assistantMessageId: savedAssistantMessage.id,
      conversationTitle
    };
  } catch (error) {
    console.error('Error al guardar mensajes en la base de datos:', error);
    return null;
  }
}

// Función para obtener el historial de una conversación
async function getConversationHistory(conversationId: string): Promise<Array<{role: string, content: string}> | null> {
  try {
    if (!isValidUUID(conversationId)) {
      console.error(`ID de conversación no válido: ${conversationId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo historial de conversación: ${conversationId}`);
    
    // Consultar todos los mensajes de la conversación ordenados por fecha de creación
    const { data, error } = await supabaseAdmin
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    
    if (error) {
      console.error('Error al obtener mensajes de la conversación:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontraron mensajes para la conversación: ${conversationId}`);
      return [];
    }
    
    console.log(`✅ Se encontraron ${data.length} mensajes en la conversación`);
    
    // Log de roles encontrados para depuración
    const rolesFound = data.map(msg => msg.role || msg.sender_type || 'undefined').join(', ');
    console.log(`🔍 Roles encontrados en los mensajes: ${rolesFound}`);
    
    // Formatear los mensajes para el contexto del comando
    const formattedMessages = data.map(msg => {
      // Determinar el rol según los campos disponibles
      let role = 'user';
      
      if (msg.role) {
        // Si el campo role existe, usarlo directamente
        role = msg.role;
      } else if (msg.sender_type) {
        // Si existe sender_type, usarlo directamente también
        role = msg.sender_type;
      } else if (msg.visitor_id) {
        // Si hay visitor_id pero no role ni sender_type, asignar 'visitor'
        role = 'visitor';
      } else if (!msg.user_id) {
        // Si no hay user_id, asumimos que es asistente
        role = 'assistant';
      }
      
      // Log detallado para depuración
      console.log(`📝 Mensaje ${msg.id}: role=${role}, visitor_id=${msg.visitor_id || 'N/A'}, user_id=${msg.user_id || 'N/A'}`);
      
      return {
        role,
        content: msg.content
      };
    });
    
    return formattedMessages;
  } catch (error) {
    console.error('Error al obtener historial de conversación:', error);
    return null;
  }
}

// Función para formatear el historial de conversación como texto para el contexto
function formatConversationHistoryForContext(messages: Array<{role: string, content: string}>): string {
  if (!messages || messages.length === 0) {
    return '';
  }
  
  let formattedHistory = '```conversation\n';
  
  messages.forEach((msg, index) => {
    // Mejorado para soportar múltiples tipos de roles
    let roleDisplay = 'ASSISTANT';
    
    // Mapear diferentes roles a su visualización adecuada
    if (msg.role === 'user' || msg.role === 'visitor') {
      roleDisplay = 'USER';
    } else if (msg.role === 'team_member') {
      roleDisplay = 'TEAM';
    } else if (msg.role === 'assistant' || msg.role === 'agent') {
      roleDisplay = 'ASSISTANT';
    } else if (msg.role === 'system') {
      roleDisplay = 'SYSTEM';
    }
    
    formattedHistory += `[${index + 1}] ${roleDisplay}: ${msg.content.trim()}\n`;
    
    // Add a separator between messages for better readability
    if (index < messages.length - 1) {
      formattedHistory += '---\n';
    }
  });
  
  formattedHistory += '```';
  return formattedHistory;
}

// Función para buscar un lead por email, teléfono o nombre
async function findLeadByInfo(email?: string, phone?: string, name?: string, siteId?: string): Promise<string | null> {
  try {
    if (!email && !phone && !name) {
      console.log(`⚠️ No se proporcionó información para buscar lead`);
      return null;
    }
    
    let query = supabaseAdmin.from('leads').select('id');
    
    // Siempre filtrar por site_id si está disponible
    if (siteId) {
      query = query.eq('site_id', siteId);
      console.log(`🔍 Filtrando búsqueda de lead por site_id="${siteId}"`);
    }
    
    // Construir la consulta según los datos disponibles
    if (email && phone) {
      // Si tenemos ambos, email y phone, usar correctamente el operador OR de Supabase
      query = query.or(`email.eq.${email},phone.eq.${phone}`);
      console.log(`🔍 Buscando lead con email="${email}" O phone="${phone}"`);
    } else {
      // Si solo tenemos uno de los dos, usar el operador eq correspondiente
      if (email) {
        query = query.eq('email', email);
        console.log(`🔍 Buscando lead con email="${email}"`);
      }
      
      if (phone) {
        query = query.eq('phone', phone);
        console.log(`🔍 Buscando lead con phone="${phone}"`);
      }
    }
    
    // Solo usar name como último recurso si no hay email ni phone
    if (name && !email && !phone) {
      query = query.eq('name', name);
      console.log(`🔍 Buscando lead solo con name="${name}"`);
    }
    
    // Ejecutar la consulta
    const { data, error } = await query.limit(1);
    
    if (error) {
      console.error('Error al buscar lead por información:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró lead con la información proporcionada ${siteId ? `para el sitio ${siteId}` : ''}`);
      return null;
    }
    
    console.log(`✅ Lead encontrado con ID: ${data[0].id} ${siteId ? `para el sitio ${siteId}` : ''}`);
    return data[0].id;
  } catch (error) {
    console.error('Error al buscar lead por información:', error);
    return null;
  }
}

// Función para crear un nuevo lead
async function createLead(name: string, email?: string, phone?: string, siteId?: string, visitorId?: string): Promise<string | null> {
  try {
    // Validar que tengamos al menos la información básica necesaria
    if (!name) {
      console.error('❌ No se puede crear un lead sin nombre');
      return null;
    }
    
    console.log(`➕ Creando nuevo lead con name=${name}, email=${email || 'N/A'}, phone=${phone || 'N/A'}, site_id=${siteId || 'N/A'}, visitor_id=${visitorId || 'N/A'}`);
    
    // Crear objeto con datos mínimos
    const leadData: any = {
      name: name,
      status: 'contacted',
      origin: 'chat'
    };
    
    // Agregar campos opcionales si están presentes
    if (email) leadData.email = email;
    if (phone) leadData.phone = phone;
    
    // Primero obtenemos los datos completos del sitio para usar site.id y site.user_id
    if (siteId && isValidUUID(siteId)) {
      try {
        const { data: site, error: siteError } = await supabaseAdmin
          .from('sites')
          .select('id, user_id')
          .eq('id', siteId)
          .single();
        
        if (siteError) {
          console.error(`❌ Error al obtener sitio: ${siteError.message}`);
        } else if (site) {
          // Usar directamente site.id y site.user_id
          leadData.site_id = site.id;
          leadData.user_id = site.user_id;
          console.log(`👤 Usando site.id=${site.id} y site.user_id=${site.user_id} directamente`);
        } else {
          // Fallback a siteId si no se pudo obtener el sitio
          leadData.site_id = siteId;
          console.warn(`⚠️ No se encontró el sitio ${siteId}, usando el ID proporcionado`);
        }
      } catch (e) {
        console.error('❌ Excepción al obtener datos del sitio:', e);
        // Fallback a siteId
        leadData.site_id = siteId;
      }
    }
    
    console.log(`📦 Datos para crear lead:`, JSON.stringify(leadData));
    
    // Intentar insertar el lead directamente
    const { data, error } = await supabaseAdmin
      .from('leads')
      .insert([leadData])
      .select()
      .single();
    
    if (error) {
      console.error(`❌ Error al crear nuevo lead (código ${error.code}):`, error.message);
      console.error(`❌ Detalles del error:`, JSON.stringify(error));
      console.error(`❌ Datos que se intentaron insertar:`, JSON.stringify(leadData));
      
      // Si el error es de constraint unique, puede ser que el lead ya exista
      if (error.code === '23505') { // Código PostgreSQL para "unique violation"
        console.log('🔄 Error de duplicado, intentando encontrar el lead existente...');
        // Intentar buscar el lead existente por los mismos campos
        const existingLeadId = await findLeadByInfo(email, phone, name, siteId);
        if (existingLeadId) {
          console.log(`✅ Se encontró lead existente con ID: ${existingLeadId}`);
          return existingLeadId;
        }
      }
      
      return null;
    }
    
    if (!data || !data.id) {
      console.error('❌ No se recibió ID para el lead creado');
      return null;
    }
    
    console.log(`✅ Nuevo lead creado con ID: ${data.id} ${siteId ? `para el sitio ${siteId}` : ''}`);
    return data.id;
  } catch (error) {
    console.error('❌ Excepción al crear nuevo lead:', error);
    return null;
  }
}

// Función auxiliar para manejar CORS
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version',
    'Access-Control-Max-Age': '86400',
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Debug para ver los parámetros de la solicitud
    console.log("🔍 POST /api/agents/customerSupport/message - Cuerpo de la solicitud:", JSON.stringify(body));
    console.log("🔍 Headers:", JSON.stringify(Object.fromEntries(request.headers)));
    console.log("🔍 Origen:", request.headers.get('origin'));
    
    // Extract required parameters from the request
    const { 
      conversationId, 
      userId, 
      message, 
      agentId, 
      site_id, 
      lead_id, 
      visitor_id,
      name,
      email,
      phone
    } = body;
    
    // Verificamos si tenemos al menos un identificador de usuario o cliente
    if (!visitor_id && !lead_id && !userId && !site_id) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'At least one identification parameter (visitor_id, lead_id, userId, or site_id) is required' } },
        { status: 400 }
      );
    }
    
    // Validar que cualquier ID proporcionado sea un UUID válido
    if (userId && !isValidUUID(userId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    if (visitor_id && !isValidUUID(visitor_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'visitor_id must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    if (lead_id && !isValidUUID(lead_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'lead_id must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    if (site_id && !isValidUUID(site_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    if (!message) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'message is required' } },
        { status: 400 }
      );
    }
    
    // Establecer el site_id efectivo
    let effectiveSiteId = site_id;
    if (effectiveSiteId) {
      console.log(`📍 Using provided site_id: ${effectiveSiteId}`);
    } else {
      console.log(`⚠️ No site_id provided for request`);
    }
    
    // Manejar lead_id - buscar o crear lead si se proporciona información
    let effectiveLeadId = lead_id;
    if (!effectiveLeadId && (name || email || phone)) {
      console.log(`🔍 Buscando o creando lead con: name=${name || 'N/A'}, email=${email || 'N/A'}, phone=${phone || 'N/A'}, site_id=${effectiveSiteId || 'N/A'}`);
      
      // Primero intentar buscar un lead existente si tenemos email o phone
      let foundLeadId = null;
      if (email || phone) {
        console.log(`🔎 Intentando buscar lead existente por email o teléfono ${effectiveSiteId ? `para el sitio ${effectiveSiteId}` : ''}`);
        foundLeadId = await findLeadByInfo(email, phone, name, effectiveSiteId);
      }
      
      if (foundLeadId) {
        console.log(`✅ Lead existente encontrado con ID: ${foundLeadId}`);
        effectiveLeadId = foundLeadId;
      } else {
        // Si no se encuentra lead, tenemos que crear uno nuevo específico para este sitio
        if (name) {
          console.log(`🆕 No se encontró lead existente. Creando nuevo lead con nombre: ${name} para el sitio: ${effectiveSiteId || 'sin sitio'}`);
          
          // Verificar email y phone para diagnóstico
          if (!email) console.log(`⚠️ Creando lead sin email`);
          if (!phone) console.log(`⚠️ Creando lead sin teléfono`);
          if (!effectiveSiteId) console.log(`⚠️ Creando lead sin sitio asociado`);
          
          const newLeadId = await createLead(name, email, phone, effectiveSiteId, visitor_id);
          
          if (newLeadId) {
            console.log(`✅ Nuevo lead creado exitosamente con ID: ${newLeadId}`);
            effectiveLeadId = newLeadId;
          } else {
            console.error(`❌ Error al crear nuevo lead para: ${name} en sitio: ${effectiveSiteId || 'sin sitio'}`);
            
            // Intentar diagnóstico del problema
            console.error(`❌ Diagnóstico: ¿Existe la tabla 'leads'? Comprobando estructura...`);
            try {
              const { data: tableInfo, error: tableError } = await supabaseAdmin
                .rpc('get_table_ddl', { table_name: 'leads' });
              
              if (tableError) {
                console.error(`❌ Error al consultar estructura de tabla:`, tableError);
              } else {
                console.log(`ℹ️ Estructura de tabla 'leads' encontrada:`, tableInfo);
              }
            } catch (e) {
              console.error(`❌ Excepción al consultar estructura de tabla:`, e);
            }
          }
        } else {
          console.log(`⚠️ No hay suficiente información para crear un lead (se requiere al menos el nombre)`);
        }
      }
    }
    
    // Verificar si tenemos un lead_id efectivo después de la búsqueda/creación
    if (effectiveLeadId) {
      console.log(`👤 Usando lead_id: ${effectiveLeadId} para esta conversación`);
    } else {
      console.log(`⚠️ No hay lead_id disponible para esta conversación. Causas posibles:`);
      if (!name && !email && !phone) {
        console.log(`   - No se proporcionó información de contacto (nombre, email o teléfono)`);
      } else if (!name) {
        console.log(`   - Se proporcionó email/teléfono pero falta nombre`);
      } else {
        console.log(`   - Error al crear/buscar el lead en la base de datos (ver errores anteriores)`);
      }
    }
    
    // Buscar agente de soporte al cliente activo si no se proporciona un agent_id
    let effectiveAgentId = agentId;
    let agentUserId: string | null = null;
    
    if (!effectiveAgentId) {
      if (effectiveSiteId) {
        // Buscar un agente activo en la base de datos para el sitio
        const foundAgent = await findActiveCustomerSupportAgent(effectiveSiteId);
        if (foundAgent) {
          effectiveAgentId = foundAgent.agentId;
          agentUserId = foundAgent.userId;
          console.log(`🤖 Usando agente de soporte al cliente encontrado: ${effectiveAgentId} (user_id: ${agentUserId})`);
        } else {
          // Usar un valor predeterminado como último recurso
          effectiveAgentId = 'default_customer_support_agent';
          console.log(`⚠️ No se encontró un agente activo, usando valor predeterminado: ${effectiveAgentId}`);
        }
      } else {
        // No tenemos site_id, usamos valor predeterminado
        effectiveAgentId = 'default_customer_support_agent';
        console.log(`⚠️ No se puede buscar un agente sin site_id, usando valor predeterminado: ${effectiveAgentId}`);
      }
    } else if (isValidUUID(effectiveAgentId)) {
      // Si ya tenemos un agentId válido, obtenemos su información completa
      const agentInfo = await getAgentInfo(effectiveAgentId);
      if (agentInfo) {
        agentUserId = agentInfo.user_id;
        // Si no tenemos site_id, usamos el del agente
        if (!effectiveSiteId && agentInfo.site_id) {
          effectiveSiteId = agentInfo.site_id;
          console.log(`📍 Usando site_id del agente: ${effectiveSiteId}`);
        }
      }
    }
    
    // Determinamos qué ID usar para el comando (preferimos userId si está disponible)
    // Ahora también consideramos el user_id del agente como opción
    const effectiveUserId = userId || agentUserId || visitor_id || lead_id;
    
    if (!effectiveUserId) {
      console.error(`❌ No se pudo determinar un user_id válido para el comando`);
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'Unable to determine a valid user_id for the command' } },
        { status: 400 }
      );
    }
    
    console.log(`Creando comando para agente: ${effectiveAgentId}, usuario: ${effectiveUserId}, site: ${effectiveSiteId || 'N/A'}`);
    
    // Retrieve conversation history if a conversation ID is provided
    let contextMessage = `Current message: ${message}`;
    
    // Añadir información del lead al contexto si está disponible
    if (effectiveLeadId || name || email || phone) {
      contextMessage += "\n\nLead Information:";
      if (effectiveLeadId) contextMessage += `\nLead ID: ${effectiveLeadId}`;
      if (name) contextMessage += `\nName: ${name}`;
      if (email) contextMessage += `\nEmail: ${email}`;
      if (phone) contextMessage += `\nPhone: ${phone}`;
    }
    
    if (conversationId && isValidUUID(conversationId)) {
      console.log(`🔄 Recuperando historial para la conversación: ${conversationId}`);
      const historyMessages = await getConversationHistory(conversationId);
      
      if (historyMessages && historyMessages.length > 0) {
        // Filter out any messages that might be duplicates of the current message
        // This prevents the current message from appearing twice in the context
        const filteredMessages = historyMessages.filter(msg => {
          // No filtrar mensajes de asistente o team_member
          if (msg.role === 'assistant' || msg.role === 'team_member' || msg.role === 'system') {
            return true;
          }
          // Para mensajes de usuario o visitante, comparar el contenido
          return msg.content.trim() !== message.trim();
        });
        
        if (filteredMessages.length > 0) {
          const conversationHistory = formatConversationHistoryForContext(filteredMessages);
          contextMessage = `${contextMessage}\n\nConversation History:\n${conversationHistory}\n\nConversation ID: ${conversationId}`;
          console.log(`📜 Historial de conversación recuperado con ${filteredMessages.length} mensajes`);
        } else {
          contextMessage = `${contextMessage}\nConversation ID: ${conversationId}`;
        }
      } else {
        contextMessage = `${contextMessage}\nConversation ID: ${conversationId}`;
        console.log(`⚠️ No se encontró historial para la conversación: ${conversationId}`);
      }
    }
    
    // Create the command using CommandFactory with the conversation history in the context
    const command = CommandFactory.createCommand({
      task: 'create message',
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      // Add site_id as a basic property if it exists
      ...(effectiveSiteId ? { site_id: effectiveSiteId } : {}),
      // Add lead_id as a basic property if it exists
      ...(effectiveLeadId ? { lead_id: effectiveLeadId } : {}),
      description: 'Respond helpfully to the customer, assist with order status inquiries, and provide solutions for any issues with their recent purchase.',
      // Set the target as a message with content
      targets: [
        {
          message: {
            content: "message example" // Will be filled by the agent
          }
        },
        {
          conversation: {
            title: "conversation title" // Will be filled by the agent
          }
        }
      ],
      // Define the tools as specified in the documentation
      tools: [
        {
          type: "function",
          async: true,
          function: {
            name: 'DELEGATE_CONVERSATION',
            description: 'escalate when needed to a specific department or role',
            parameters: {
              type: 'object',
              properties: {
                conversation: {
                  type: 'string',
                  description: 'The conversation ID that needs to be escalated'
                },
                lead_id: {
                  type: 'string',
                  description: 'The ID of the lead or customer related to this escalation'
                },
                target: {
                  type: 'string',
                  enum: ['Sales/CRM Specialist', 'Growth Lead/Manager'],
                  description: 'The department or role to escalate the conversation to'
                },
                summary: {
                  type: 'string',
                  description: 'A brief summary of the issue or reason for escalation'
                }
              },
              required: ['conversation', 'lead_id'],
              additionalProperties: false
            },
            strict: true
          }
        },
        {
          type: "function",
          async: true,
          function: {
            name: 'CONTACT_HUMAN',
            description: 'contact human supervisor when complex issues require human intervention',
            parameters: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'The found name of the visitor that is requesting the human intervention'
                },
                email: {
                  type: 'string',
                  description: 'The found email of the visitor that is requesting the human intervention'
                },
                conversation_id: {
                  type: 'string',
                  description: 'The conversation ID that requires human attention'
                },
                summary: {
                  type: 'string',
                  description: 'A brief summary of the issue or reason for escalation'
                },
                message: {
                  type: 'string',
                  description: 'The message to be sent to the human supervisor'
                },
                priority: {
                  type: 'string',
                  enum: ['normal', 'high', 'urgent'],
                  description: 'The priority level of the request'
                },
                lead_id: {
                  type: 'string',
                  description: 'The ID of the lead or customer that needs assistance'
                }
              },
              required: ['conversation_id', 'summary', 'message', 'priority', 'name', 'email'],
              additionalProperties: false
            },
            strict: true
          }
        },
        {
          type: "function",
          async: true,
          function: {
            name: 'IDENTIFY_LEAD',
            description: 'collect visitor information when lead or visitor data is missing from context',
            parameters: {
              type: 'object',
              properties: {
                conversation: {
                  type: 'string',
                  description: 'The conversation ID for the current interaction'
                },
                name: {
                  type: 'string',
                  description: 'Name of the visitor'
                },
                email: {
                  type: 'string',
                  description: 'Email address of the visitor'
                },
                phone: {
                  type: 'string',
                  description: 'Phone number of the visitor'
                },
                company: {
                  type: 'string',
                  description: 'Company name of the visitor'
                }
              },
              required: ['name', 'email', 'phone'],
              additionalProperties: false
            },
            strict: true
          }
        }
      ],
      // Context includes the current message and conversation history
      context: contextMessage,
      // Add supervisors as specified in the documentation
      supervisor: [
        {
          agent_role: 'sales',
          status: 'not_initialized'
        },
        {
          agent_role: 'manager',
          status: 'not_initialized'
        }
      ]
    });
    
    // Submit the command for processing
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
    
    // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
    let initialDbUuid = await getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
    }
    
    // Esperar a que el comando se complete utilizando nuestra función
    const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
    
    // Usar el UUID obtenido inicialmente si no tenemos uno válido después de la ejecución
    const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
    
    // Verificar que tenemos un UUID de base de datos válido
    if (!effectiveDbUuid || !isValidUUID(effectiveDbUuid)) {
      console.error(`❌ No se pudo obtener un UUID válido de la base de datos para el comando ${internalCommandId}`);
      
      // En este caso, seguimos adelante con el ID interno en lugar de fallar
      console.log(`⚠️ Continuando con el ID interno como respaldo: ${internalCommandId}`);
      
      if (!completed || !executedCommand) {
        console.error(`❌ Error en ejecución del comando, completed=${completed}, executedCommand=${!!executedCommand}`);
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'COMMAND_EXECUTION_FAILED', 
              message: 'The command did not complete successfully in the expected time' 
            },
            debug: {
              agent_id: effectiveAgentId,
              user_id: effectiveUserId,
              agent_user_id: agentUserId,
              site_id: effectiveSiteId
            }
          },
          { 
            status: 500,
            headers: corsHeaders()
          }
        );
      }
      
      // Extraer la respuesta del asistente
      let assistantMessage = "No response generated";
      let conversationTitle = null;
      
      // Obtener resultados si existen
      if (executedCommand.results && Array.isArray(executedCommand.results)) {
        // Extraer el título de la conversación de los resultados
        const conversationResults = executedCommand.results.find((r: any) => 
          r.conversation && r.conversation.title
        );
        
        if (conversationResults) {
          conversationTitle = conversationResults.conversation.title;
          console.log(`🏷️ Título de conversación encontrado: "${conversationTitle}"`);
        } else {
          // Búsqueda alternativa del título en otras estructuras posibles
          const altTitleResults = executedCommand.results.find((r: any) => 
            (r.content && r.content.conversation && r.content.conversation.title) ||
            (r.type === 'conversation' && r.content && r.content.title)
          );
          
          if (altTitleResults) {
            if (altTitleResults.content && altTitleResults.content.conversation) {
              conversationTitle = altTitleResults.content.conversation.title;
            } else if (altTitleResults.content && altTitleResults.content.title) {
              conversationTitle = altTitleResults.content.title;
            }
            console.log(`🏷️ Título de conversación encontrado (formato alternativo): "${conversationTitle}"`);
          }
        }
        
        // Buscar mensajes en los resultados - la estructura real es { message: { content: string } }
        const messageResults = executedCommand.results.filter((r: any) => r.message && r.message.content);
        
        if (messageResults.length > 0 && messageResults[0].message.content) {
          assistantMessage = messageResults[0].message.content;
        }
      }
      
      console.log(`💬 Mensaje del asistente: ${assistantMessage.substring(0, 50)}...`);
      
      // Usando lead_id efectivo al guardar los mensajes
      const savedMessages = await saveMessages(
        effectiveUserId, 
        message, 
        assistantMessage, 
        conversationId, 
        conversationTitle, 
        effectiveLeadId, 
        visitor_id, 
        effectiveAgentId, 
        effectiveSiteId, 
        effectiveDbUuid || undefined
      );
      
      if (!savedMessages) {
        console.error(`❌ Error al guardar mensajes en la base de datos`);
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'DATABASE_ERROR', 
              message: 'The command completed but the messages could not be saved to the database' 
            },
            data: {
              command_id: effectiveDbUuid,
              message: assistantMessage,
              conversation_title: conversationTitle,
              lead_id: effectiveLeadId || null
            },
            debug: {
              agent_id: effectiveAgentId,
              user_id: effectiveUserId,
              agent_user_id: agentUserId,
              site_id: effectiveSiteId
            }
          },
          { 
            status: 500,
            headers: corsHeaders()
          }
        );
      }
      
      return NextResponse.json(
        { 
          success: true, 
          data: { 
            command_id: effectiveDbUuid,
            conversation_id: savedMessages.conversationId,
            conversation_title: savedMessages.conversationTitle,
            lead_id: effectiveLeadId || null,
            messages: {
              user: {
                content: message,
                message_id: savedMessages.userMessageId,
                command_id: effectiveDbUuid
              },
              assistant: {
                content: assistantMessage,
                message_id: savedMessages.assistantMessageId,
                command_id: effectiveDbUuid
              }
            },
            debug: {
              agent_id: effectiveAgentId,
              user_id: effectiveUserId,
              agent_user_id: agentUserId,
              site_id: effectiveSiteId
            }
          } 
        },
        { 
          status: 200,
          headers: corsHeaders()
        }
      );
    }
    
    if (!completed || !executedCommand) {
      console.error(`❌ Error en ejecución del comando, completed=${completed}, executedCommand=${!!executedCommand}`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'The command did not complete successfully in the expected time' 
          },
          debug: {
            agent_id: effectiveAgentId,
            user_id: effectiveUserId,
            agent_user_id: agentUserId,
            site_id: effectiveSiteId
          }
        },
        { 
          status: 500,
          headers: corsHeaders()
        }
      );
    }
    
    // Extraer la respuesta del asistente
    let assistantMessage = "No response generated";
    let conversationTitle = null;
    
    // Obtener resultados si existen
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      // Extraer el título de la conversación de los resultados
      const conversationResults = executedCommand.results.find((r: any) => 
        r.conversation && r.conversation.title
      );
      
      if (conversationResults) {
        conversationTitle = conversationResults.conversation.title;
        console.log(`🏷️ Título de conversación encontrado: "${conversationTitle}"`);
      } else {
        // Búsqueda alternativa del título en otras estructuras posibles
        const altTitleResults = executedCommand.results.find((r: any) => 
          (r.content && r.content.conversation && r.content.conversation.title) ||
          (r.type === 'conversation' && r.content && r.content.title)
        );
        
        if (altTitleResults) {
          if (altTitleResults.content && altTitleResults.content.conversation) {
            conversationTitle = altTitleResults.content.conversation.title;
          } else if (altTitleResults.content && altTitleResults.content.title) {
            conversationTitle = altTitleResults.content.title;
          }
          console.log(`🏷️ Título de conversación encontrado (formato alternativo): "${conversationTitle}"`);
        }
      }
      
      // Buscar mensajes en los resultados - la estructura real es { message: { content: string } }
      const messageResults = executedCommand.results.filter((r: any) => r.message && r.message.content);
      
      if (messageResults.length > 0 && messageResults[0].message.content) {
        assistantMessage = messageResults[0].message.content;
      }
    }
    
    console.log(`💬 Mensaje del asistente: ${assistantMessage.substring(0, 50)}...`);
    
    // Usando lead_id efectivo al guardar los mensajes
    const savedMessages = await saveMessages(
      effectiveUserId, 
      message, 
      assistantMessage, 
      conversationId, 
      conversationTitle, 
      effectiveLeadId,
      visitor_id, 
      effectiveAgentId, 
      effectiveSiteId, 
      effectiveDbUuid || undefined
    );
    
    if (!savedMessages) {
      console.error(`❌ Error al guardar mensajes en la base de datos`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATABASE_ERROR', 
            message: 'The command completed but the messages could not be saved to the database' 
          },
          data: {
            command_id: effectiveDbUuid,
            message: assistantMessage,
            conversation_title: conversationTitle,
            lead_id: effectiveLeadId || null
          },
          debug: {
            agent_id: effectiveAgentId,
            user_id: effectiveUserId,
            agent_user_id: agentUserId,
            site_id: effectiveSiteId
          }
        },
        { 
          status: 500,
          headers: corsHeaders()
        }
      );
    }
    
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: effectiveDbUuid,
          conversation_id: savedMessages.conversationId,
          conversation_title: savedMessages.conversationTitle,
          lead_id: effectiveLeadId || null,
          messages: {
            user: {
              content: message,
              message_id: savedMessages.userMessageId,
              command_id: effectiveDbUuid
            },
            assistant: {
              content: assistantMessage,
              message_id: savedMessages.assistantMessageId,
              command_id: effectiveDbUuid
            }
          },
          debug: {
            agent_id: effectiveAgentId,
            user_id: effectiveUserId,
            agent_user_id: agentUserId,
            site_id: effectiveSiteId
          }
        } 
      },
      { 
        status: 200,
        headers: corsHeaders()
      }
    );
  } catch (error) {
    console.error(`❌ Error en el manejo de la solicitud:`, error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    );
  }
}