import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para encontrar un agente de ventas activo para un sitio
async function findActiveSalesAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente de ventas activo para el sitio: ${siteId}`);
    
    // Solo buscamos por site_id, role y status
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', 'Sales')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error al buscar agente de ventas:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente de ventas activo para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente de ventas encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error al buscar agente de ventas:', error);
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
async function waitForCommandCompletion(commandId: string, maxAttempts = 100, delayMs = 1000) {
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
      
      // Solo añadir lead_id si está presente y es un dato requerido
      // (por ejemplo, si estamos en una conversación relacionada con un lead específico)
      if (leadId && !agentId) {
        conversationData.lead_id = leadId;
        console.log(`⚠️ Agregando lead_id a la conversación porque no hay agentId`);
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
    } else if (conversationTitle || siteId) {
      // Actualizar la conversación existente si se proporciona un nuevo título o site_id
      const updateData: any = {};
      if (conversationTitle) updateData.title = conversationTitle;
      if (siteId) updateData.site_id = siteId;
      
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
    
    // Solo agregar lead_id si está presente y no hay un agente en la conversación
    if (leadId && !agentId) {
      userMessageObj.lead_id = leadId;
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
    
    // Solo agregar lead_id si está presente y no hay un agente en la conversación
    if (leadId && !agentId) {
      assistantMessageObj.lead_id = leadId;
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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extract required parameters from the request
    const { conversationId, userId, message, agentId, site_id, lead_id, visitor_id } = body;
    
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
    
    // Buscar agente de ventas activo si no se proporciona un agent_id
    let effectiveAgentId = agentId;
    let agentUserId: string | null = null;
    
    if (!effectiveAgentId) {
      if (effectiveSiteId) {
        // Buscar un agente activo en la base de datos para el sitio
        const foundAgent = await findActiveSalesAgent(effectiveSiteId);
        if (foundAgent) {
          effectiveAgentId = foundAgent.agentId;
          agentUserId = foundAgent.userId;
          console.log(`🤖 Usando agente de ventas encontrado: ${effectiveAgentId} (user_id: ${agentUserId})`);
        } else {
          // Usar un valor predeterminado como último recurso
          effectiveAgentId = 'default_sales_agent';
          console.log(`⚠️ No se encontró un agente activo, usando valor predeterminado: ${effectiveAgentId}`);
        }
      } else {
        // No tenemos site_id, usamos valor predeterminado
        effectiveAgentId = 'default_sales_agent';
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
    let contextMessage = `${message}`;
    
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
      agentRole: 'Sales/CRM Specialist',
      // Add site_id as a basic property if it exists
      ...(effectiveSiteId ? { site_id: effectiveSiteId } : {}),
      description: 'Engage with potential customers to understand their needs, suggest appropriate products/services, handle objections, and facilitate the sales process.',
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
            name: 'SCHEDULE_MEETING',
            description: 'Schedule a meeting or product demo with the lead',
            parameters: {
              type: 'object',
              properties: {
                conversation: {
                  type: 'string',
                  description: 'The conversation ID for the current interaction'
                },
                lead_id: {
                  type: 'string',
                  description: 'The ID of the lead to schedule with'
                },
                purpose: {
                  type: 'string',
                  description: 'Brief description of the meeting purpose (product demo, consultation, etc.)'
                },
                preferred_date: {
                  type: 'string',
                  description: 'Preferred date for the meeting (ISO format or natural language)'
                },
                preferred_time: {
                  type: 'string',
                  description: 'Preferred time for the meeting'
                }
              },
              required: ['conversation', 'lead_id', 'purpose'],
              additionalProperties: false
            },
            strict: true
          }
        },
        {
          type: "function",
          async: true,
          function: {
            name: 'CREATE_SALE',
            description: 'Create a new sales order or opportunity based on customer needs',
            parameters: {
              type: 'object',
              properties: {
                conversation: {
                  type: 'string',
                  description: 'The conversation ID for the current interaction'
                },
                lead_id: {
                  type: 'string',
                  description: 'The ID of the lead or customer for this sale'
                },
                products: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: {
                        type: 'string',
                        description: 'Product or service name'
                      },
                      quantity: {
                        type: 'number',
                        description: 'Quantity of this product'
                      },
                      price: {
                        type: 'number',
                        description: 'Price per unit'
                      }
                    },
                    required: ['name']
                  },
                  description: 'List of products or services the customer is interested in'
                },
                notes: {
                  type: 'string',
                  description: 'Additional notes about the sale'
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
        },
        {
          type: "function",
          async: true,
          function: {
            name: 'CREATE_TASK',
            description: 'create a new task for lead follow-up, customer support activities, or other customer interactions',
            parameters: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: 'Title of the task to be created'
                },
                type: {
                  type: 'string',
                  description: 'Type of task to create (e.g., call, email, demo, meeting, quote, payment, follow_up, support, custom types allowed)'
                },
                lead_id: {
                  type: 'string',
                  description: 'The ID of the lead this task is related to (required)'
                },
                description: {
                  type: 'string',
                  description: 'Detailed description of what needs to be done'
                },
                stage: {
                  type: 'string',
                  enum: ['awareness', 'consideration', 'decision', 'purchase', 'retention', 'referral'],
                  description: 'Stage from customer journey'
                },
                scheduled_date: {
                  type: 'string',
                  format: 'date-time',
                  description: 'When the task should be scheduled (or the same day if not specified) (ISO 8601 format with timezone) example: 2025-03-24 20:21:51.906+00',
                },
                notes: {
                  type: 'string',
                  description: 'Additional notes about the task'
                },
                amount: {
                  type: 'number',
                  description: 'Monetary amount associated with the task (e.g., quote value, payment amount)'
                },
                address: {
                  type: 'object',
                  description: 'Address information as JSON object',
                  properties: {
                    street: {
                      type: 'string',
                      description: 'Street address'
                    },
                    city: {
                      type: 'string', 
                      description: 'City name'
                    },
                    state: {
                      type: 'string',
                      description: 'State or province'
                    },
                    postal_code: {
                      type: 'string',
                      description: 'Postal or ZIP code'
                    },
                    country: {
                      type: 'string',
                      description: 'Country name'
                    }
                  },
                  required: ['street', 'city', 'country'],
                  additionalProperties: true
                }
              },
              required: ['title', 'type', 'lead_id', "scheduled_date", "stage", "description"],
              additionalProperties: false
            },
            strict: true
          }
        },
        {
          type: "function",
          async: true,
          function: {
            name: 'UPDATE_TASK',
            description: 'update an existing task with new information, status changes, or progress updates',
            parameters: {
              type: 'object',
              properties: {
                task_id: {
                  type: 'string',
                  description: 'The ID of the task to update (required)'
                },
                title: {
                  type: 'string',
                  description: 'New title of the task'
                },
                type: {
                  type: 'string',
                  description: 'New type of task (e.g., call, email, demo, meeting, quote, payment, follow_up, support, custom types allowed)'
                },
                description: {
                  type: 'string',
                  description: 'New detailed description of what needs to be done'
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'failed'],
                  description: 'New status of the task'
                },
                stage: {
                  type: 'string',
                  enum: ['awareness', 'consideration', 'decision', 'purchase', 'retention', 'referral'],
                  description: 'New stage from customer journey'
                },
                priority: {
                  type: 'integer',
                  minimum: 0,
                  description: 'New priority level (higher numbers = higher priority)'
                },
                scheduled_date: {
                  type: 'string',
                  format: 'date-time',
                  description: 'When the task should be scheduled (or the same day if not specified) (ISO 8601 format with timezone) example: 2025-03-24 20:21:51.906+00',
                },
                amount: {
                  type: 'number',
                  description: 'New monetary amount associated with the task (e.g., quote value, payment amount)'
                },
                assignee: {
                  type: 'string',
                  description: 'ID of the user to assign the task to'
                },
                notes: {
                  type: 'string',
                  description: 'New or additional notes about the task'
                },
                address: {
                  type: 'object',
                  description: 'New address information as JSON object',
                  properties: {
                    street: {
                      type: 'string',
                      description: 'Street address'
                    },
                    city: {
                      type: 'string', 
                      description: 'City name'
                    },
                    state: {
                      type: 'string',
                      description: 'State or province'
                    },
                    postal_code: {
                      type: 'string',
                      description: 'Postal or ZIP code'
                    },
                    country: {
                      type: 'string',
                      description: 'Country name'
                    },
                    venue_name: {
                      type: 'string',
                      description: 'Name of the venue or location'
                    },
                    room: {
                      type: 'string',
                      description: 'Room or suite number'
                    },
                    floor: {
                      type: 'string',
                      description: 'Floor number'
                    },
                    parking_instructions: {
                      type: 'string',
                      description: 'Parking instructions'
                    },
                    access_code: {
                      type: 'string',
                      description: 'Access code for entry'
                    }
                  },
                  additionalProperties: true
                }
              },
              required: ['task_id'],
              additionalProperties: false
            },
            strict: true
          }
        },
        {
          type: "function",
          async: true,
          function: {
            name: 'GET_TASKS',
            description: 'retrieve tasks with filtering options to check order status, track deliveries, and review task progress',
            parameters: {
              type: 'object',
              properties: {
                lead_id: {
                  type: 'string',
                  description: 'The ID of the lead to get tasks for (primary filter)'
                },
                type: {
                  type: 'string',
                  description: 'Type of task to filter by (e.g., call, email, demo, meeting, quote, payment)'
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'failed'],
                  description: 'Status of tasks to retrieve'
                },
                stage: {
                  type: 'string',
                  enum: ['awareness', 'consideration', 'decision', 'purchase', 'retention', 'referral'],
                  description: 'Stage of tasks to filter by (from customer_journey)'
                },
                priority: {
                  type: 'integer',
                  description: 'Priority level to filter by (higher numbers = higher priority)'
                },
                search: {
                  type: 'string',
                  description: 'Search text to find in task titles or descriptions'
                },
                sort_by: {
                  type: 'string',
                  enum: ['created_at', 'updated_at', 'scheduled_date', 'priority', 'title'],
                  description: 'Field to sort results by'
                },
                sort_order: {
                  type: 'string',
                  enum: ['asc', 'desc'],
                  description: 'Sort order for results'
                },
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 100,
                  description: 'Maximum number of tasks to return'
                },
                include_completed: {
                  type: 'boolean',
                  description: 'Whether to include completed tasks in results'
                }
              },
              required: ['lead_id'],
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
          agent_role: 'sales_manager',
          status: 'not_initialized'
        },
        {
          agent_role: 'customer_support',
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
          { status: 500 }
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
      
      // Guardar los mensajes en la base de datos
      const savedMessages = await saveMessages(effectiveUserId, message, assistantMessage, conversationId, conversationTitle, lead_id, visitor_id, effectiveAgentId, effectiveSiteId, internalCommandId);
      
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
              command_id: internalCommandId,
              message: assistantMessage,
              conversation_title: conversationTitle
            },
            debug: {
              agent_id: effectiveAgentId,
              user_id: effectiveUserId,
              agent_user_id: agentUserId,
              site_id: effectiveSiteId
            }
          },
          { status: 500 }
        );
      }
      
      // Responder usando el ID interno como respaldo
      return NextResponse.json(
        { 
          success: true, 
          data: { 
            command_id: internalCommandId, // Usamos el ID interno como respaldo
            conversation_id: savedMessages?.conversationId,
            conversation_title: savedMessages?.conversationTitle,
            messages: {
              user: {
                content: message,
                message_id: savedMessages?.userMessageId,
                command_id: internalCommandId
              },
              assistant: {
                content: assistantMessage,
                message_id: savedMessages?.assistantMessageId,
                command_id: internalCommandId
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
        { status: 200 }
      );
    }
    
    if (!completed || !executedCommand) {
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
        { status: 500 }
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
    
    // Guardar los mensajes en la base de datos
    const savedMessages = await saveMessages(effectiveUserId, message, assistantMessage, conversationId, conversationTitle, lead_id, visitor_id, effectiveAgentId, effectiveSiteId, effectiveDbUuid);
    
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
            conversation_title: conversationTitle
          },
          debug: {
            agent_id: effectiveAgentId,
            user_id: effectiveUserId,
            agent_user_id: agentUserId,
            site_id: effectiveSiteId
          }
        },
        { status: 500 }
      );
    }
    
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: effectiveDbUuid,
          conversation_id: savedMessages.conversationId,
          conversation_title: savedMessages.conversationTitle,
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
      { status: 200 }
    );
  } catch (error) {
    console.error('Error al procesar la solicitud:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } },
      { status: 500 }
    );
  }
} 