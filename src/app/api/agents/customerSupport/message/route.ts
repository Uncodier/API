import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { manageLeadCreation } from '@/lib/services/leads/lead-service';
import { WorkflowService } from '@/lib/services/workflow-service';
import { WhatsAppLeadService } from '@/lib/services/whatsapp/WhatsAppLeadService';
import { ConversationService } from '@/lib/services/conversation-service';
import { normalizePhoneForSearch, normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para encontrar un agente de soporte al cliente activo para un sitio
// Función genérica para encontrar agentes activos por role
async function findActiveAgentByRole(siteId: string, role: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente activo con role "${role}" para el sitio: ${siteId}`);
    
    // Solo buscamos por site_id, role y status
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', role)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error(`Error al buscar agente con role "${role}":`, error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente activo con role "${role}" para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente con role "${role}" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error(`Error al buscar agente con role "${role}":`, error);
    return null;
  }
}

async function findActiveCustomerSupportAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Customer Support');
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

// Función para obtener información completa del lead desde la base de datos
async function getLeadInfo(leadId: string): Promise<any | null> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`ID de lead no válido: ${leadId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información completa del lead: ${leadId}`);
    
    // Consultar el lead en la base de datos
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single();
    
    if (error) {
      // PGRST116 significa que no se encontraron filas - esto es esperado cuando el lead no existe
      if (error.code === 'PGRST116') {
        console.log(`⚠️ No se encontró el lead con ID: ${leadId}`);
        return null;
      }
      console.error('Error al obtener información del lead:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ No se encontró el lead con ID: ${leadId}`);
      return null;
    }
    
    console.log(`✅ Información completa del lead recuperada: ${JSON.stringify({
      id: data.id,
      name: data.name,
      email: data.email || 'N/A',
      phone: data.phone || 'N/A',
      status: data.status || 'N/A',
      origin: data.origin || 'N/A'
    })}`);
    
    return data;
  } catch (error) {
    console.error('Error al obtener información del lead:', error);
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

// Función para validar que un lead existe en la base de datos
async function validateLeadExists(leadId: string): Promise<boolean> {
  try {
    if (!isValidUUID(leadId)) {
      console.log(`⚠️ Lead ID no válido: ${leadId}`);
      return false;
    }
    
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('id', leadId)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        console.log(`⚠️ Lead no encontrado en la base de datos: ${leadId}`);
        return false;
      }
      console.error(`❌ Error al validar lead ${leadId}:`, error);
      return false;
    }
    
    return !!data;
  } catch (error) {
    console.error(`❌ Error al validar lead ${leadId}:`, error);
    return false;
  }
}

// Function to check if a message with origin_message_id already exists and was responded to
async function checkDuplicateOriginMessage(
  originMessageId: string,
  conversationId?: string,
  leadId?: string,
  siteId?: string
): Promise<{ isDuplicate: boolean; existingMessageId?: string; conversationId?: string }> {
  try {
    if (!originMessageId) {
      return { isDuplicate: false };
    }

    console.log(`🔍 [DUPLICATE_CHECK] Checking for duplicate origin_message_id: ${originMessageId}`);

    // Build query to find messages with matching origin_message_id
    let query = supabaseAdmin
      .from('messages')
      .select('id, conversation_id, role, created_at')
      .filter('custom_data->>origin_message_id', 'eq', originMessageId)
      .order('created_at', { ascending: false });

    // If we have conversationId, filter by it for better performance
    if (conversationId) {
      query = query.eq('conversation_id', conversationId);
    }

    // If we have leadId, filter by it
    if (leadId) {
      query = query.eq('lead_id', leadId);
    }

    // If we have siteId, we can filter by conversation's site_id
    // But we need to join with conversations table, so let's get all matches first
    const { data: matchingMessages, error } = await query;

    if (error) {
      console.error(`❌ [DUPLICATE_CHECK] Error querying messages:`, error);
      return { isDuplicate: false };
    }

    if (!matchingMessages || matchingMessages.length === 0) {
      console.log(`✅ [DUPLICATE_CHECK] No messages found with origin_message_id: ${originMessageId}`);
      return { isDuplicate: false };
    }

    console.log(`📊 [DUPLICATE_CHECK] Found ${matchingMessages.length} message(s) with origin_message_id: ${originMessageId}`);

    // Group messages by conversation_id
    const messagesByConversation = new Map<string, typeof matchingMessages>();
    for (const msg of matchingMessages) {
      if (!msg.conversation_id) continue;
      if (!messagesByConversation.has(msg.conversation_id)) {
        messagesByConversation.set(msg.conversation_id, []);
      }
      messagesByConversation.get(msg.conversation_id)!.push(msg);
    }

    // Check each conversation for user message + assistant response
    for (const [convId, messages] of Array.from(messagesByConversation.entries())) {
      // If we have siteId, verify the conversation belongs to that site
      if (siteId) {
        const { data: conv, error: convError } = await supabaseAdmin
          .from('conversations')
          .select('site_id')
          .eq('id', convId)
          .single();

        if (convError || !conv || conv.site_id !== siteId) {
          continue;
        }
      }

      // Find user message (should be the one with origin_message_id)
      const userMessage = messages.find((m: { id: any; conversation_id: any; role: any; created_at: any }) => m.role === 'user');
      if (!userMessage) continue;

      // Check if there's an assistant message after the user message
      const { data: assistantMessages, error: assistantError } = await supabaseAdmin
        .from('messages')
        .select('id, created_at')
        .eq('conversation_id', convId)
        .eq('role', 'assistant')
        .gt('created_at', userMessage.created_at)
        .limit(1);

      if (assistantError) {
        console.error(`❌ [DUPLICATE_CHECK] Error checking assistant messages:`, assistantError);
        continue;
      }

      if (assistantMessages && assistantMessages.length > 0) {
        console.log(`⚠️ [DUPLICATE_CHECK] Duplicate found! Message ${userMessage.id} with origin_message_id ${originMessageId} already has an assistant response in conversation ${convId}`);
        return {
          isDuplicate: true,
          existingMessageId: userMessage.id,
          conversationId: convId
        };
      }
    }

    console.log(`✅ [DUPLICATE_CHECK] No duplicate responses found for origin_message_id: ${originMessageId}`);
    return { isDuplicate: false };
  } catch (error: any) {
    console.error(`❌ [DUPLICATE_CHECK] Error in checkDuplicateOriginMessage:`, error);
    return { isDuplicate: false };
  }
}

// Función para guardar mensajes en la base de datos
async function saveMessages(userId: string, userMessage: string, assistantMessage: string, conversationId?: string, conversationTitle?: string, leadId?: string, visitorId?: string, agentId?: string, siteId?: string, commandId?: string, origin?: string, isRobot?: boolean, isTransactionalMessage?: boolean, isErratic?: boolean, originMessageId?: string) {
  try {
    console.log(`💾 Guardando mensajes con: user_id=${userId}, agent_id=${agentId || 'N/A'}, site_id=${siteId || 'N/A'}, lead_id=${leadId || 'N/A'}, visitor_id=${visitorId || 'N/A'}, command_id=${commandId || 'N/A'}, origin=${origin || 'N/A'}, is_robot=${isRobot || false}, is_transactional_message=${isTransactionalMessage || false}, is_erratic=${isErratic || false}`);
    
    // Si es robot, mensaje transaccional o errático, lanzar error para detener el flujo de creación en DB
    if (isRobot || isTransactionalMessage || isErratic) {
      console.log(`🚨 SKIP_DATABASE: is_robot=${isRobot}, is_transactional_message=${isTransactionalMessage}, is_erratic=${isErratic} - No se crearán objetos en la base de datos`);
      const error: any = new Error('SKIP_DATABASE');
      error.code = 'SKIP_DATABASE';
      error.results = {
        message: assistantMessage,
        conversation_title: conversationTitle,
        is_robot: isRobot || false,
        is_transactional_message: isTransactionalMessage || false,
        is_erratic: isErratic || false
      };
      throw error;
    }
    
    // Validar que el lead existe si se proporciona un leadId
    let validatedLeadId: string | undefined = leadId;
    if (leadId) {
      const leadExists = await validateLeadExists(leadId);
      if (!leadExists) {
        console.log(`⚠️ Lead ${leadId} no existe en la base de datos. Continuando sin lead_id para evitar error de foreign key.`);
        validatedLeadId = undefined;
      } else {
        console.log(`✅ Lead ${leadId} validado correctamente.`);
      }
    }
    
    let effectiveConversationId: string | undefined = conversationId;
    
    // Verificar si tenemos un ID de conversación
    if (conversationId) {
      // Verificamos primero que la conversación realmente existe en la base de datos
      console.log(`🔍 Verificando existencia de conversación: ${conversationId}`);
      const { data: existingConversation, error: checkError } = await supabaseAdmin
        .from('conversations')
        .select('id, user_id, lead_id, visitor_id, agent_id, site_id, custom_data')
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
      // Late re-check: try to find an existing conversation again to avoid race conditions (especially for WhatsApp)
      // Skip late re-check for website_chat origin - always create new conversations
      if (origin !== 'website_chat') {
        try {
          if (siteId && (validatedLeadId || visitorId)) {
            const lateOrigin = origin || undefined;
            const lateExistingConversationId = await ConversationService.findExistingConversation(
              validatedLeadId,
              visitorId,
              siteId,
              lateOrigin,
              undefined,
              undefined
            );
            if (lateExistingConversationId) {
              effectiveConversationId = lateExistingConversationId;
              console.log(`♻️ Late re-check found existing conversation: ${effectiveConversationId}`);
            }
          }
        } catch (lateErr) {
          console.log('⚠️ Late re-check for existing conversation failed:', lateErr);
        }
      } else {
        console.log(`🌐 Skipping late re-check for website_chat origin - will create new conversation`);
      }

      // If still no conversation, create a new one
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
      
      // Añadir lead_id solo si está validado (existe en la base de datos)
      if (validatedLeadId) {
        conversationData.lead_id = validatedLeadId;
        console.log(`✅ Agregando lead_id validado ${validatedLeadId} a la nueva conversación`);
      } else if (leadId) {
        console.log(`⚠️ Lead ID ${leadId} no se agregará a la conversación porque no existe en la base de datos`);
      }
      
      // Añadir el título si está presente
      if (conversationTitle) conversationData.title = conversationTitle;
      
      // Añadir custom_data con channel si origin está presente
      if (origin) {
        conversationData.custom_data = {
          channel: origin
        };
        conversationData.channel = origin; // También guardar como propiedad directa
        console.log(`📺 Estableciendo channel="${origin}" en custom_data y como propiedad directa de la conversación`);
      }
      
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
      }
    } else if (conversationTitle || siteId || validatedLeadId || origin) {
      // Actualizar la conversación existente si se proporciona un nuevo título, site_id, lead_id o origin
      const updateData: any = {};
      if (conversationTitle) updateData.title = conversationTitle;
      if (siteId) updateData.site_id = siteId;
      if (validatedLeadId) updateData.lead_id = validatedLeadId;
      
      // Actualizar custom_data con channel si origin está presente
      if (origin) {
        // Primero obtenemos el custom_data existente
        const { data: existingConv, error: fetchError } = await supabaseAdmin
          .from('conversations')
          .select('custom_data')
          .eq('id', effectiveConversationId)
          .single();
        
        let existingCustomData = {};
        if (!fetchError && existingConv && existingConv.custom_data) {
          existingCustomData = existingConv.custom_data;
        }
        
        updateData.custom_data = {
          ...existingCustomData,
          channel: origin
        };
        updateData.channel = origin; // También actualizar como propiedad directa
        console.log(`📺 Actualizando channel="${origin}" en custom_data y como propiedad directa de la conversación`);
      }
      
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
        if (validatedLeadId) {
          console.log(`👤 Lead ID de conversación actualizado: "${validatedLeadId}"`);
        }
        if (origin) {
          console.log(`📺 Channel de conversación actualizado: "${origin}"`);
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
    
    // Agregar lead_id si está validado (independientemente del agentId)
    if (validatedLeadId) {
      userMessageObj.lead_id = validatedLeadId;
      console.log(`👤 Agregando lead_id validado ${validatedLeadId} al mensaje del usuario`);
    }
    
    // Agregar agent_id si está presente
    if (agentId) userMessageObj.agent_id = agentId;
    
    // Agregar command_id si está presente y es un UUID válido
    if (commandId && isValidUUID(commandId)) {
      // Verify command exists in database before adding to message
      const { data: commandExists, error: commandCheckError } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('id', commandId)
        .single();
      
      if (commandCheckError) {
        // Check if it's a "no rows found" error (PGRST116) or a real database error
        if (commandCheckError.code === 'PGRST116') {
          console.warn(`⚠️ Command ${commandId} does not exist in database (PGRST116), skipping command_id in user message`);
        } else {
          // Real database error - log it but don't add command_id to avoid invalid foreign key
          console.error(`❌ Database error checking command ${commandId}:`, commandCheckError);
          console.warn(`⚠️ Skipping command_id in user message due to database error (cannot verify existence)`);
        }
      } else if (commandExists) {
        userMessageObj.command_id = commandId;
      } else {
        console.warn(`⚠️ Command ${commandId} does not exist in database, skipping command_id in user message`);
      }
    }
    
    // Agregar origin_message_id a custom_data si está presente
    if (originMessageId) {
      userMessageObj.custom_data = {
        ...(userMessageObj.custom_data || {}),
        origin_message_id: originMessageId
      };
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
    
    // Agregar lead_id si está validado (independientemente del agentId)
    if (validatedLeadId) {
      assistantMessageObj.lead_id = validatedLeadId;
      console.log(`👤 Agregando lead_id validado ${validatedLeadId} al mensaje del asistente`);
    }
    
    // Agregar agent_id si está presente
    if (agentId) assistantMessageObj.agent_id = agentId;
    
    // Agregar command_id si está presente y es un UUID válido
    if (commandId && isValidUUID(commandId)) {
      // Verify command exists in database before adding to message
      const { data: commandExists, error: commandCheckError } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('id', commandId)
        .single();
      
      if (commandCheckError) {
        // Check if it's a "no rows found" error (PGRST116) or a real database error
        if (commandCheckError.code === 'PGRST116') {
          console.warn(`⚠️ Command ${commandId} does not exist in database (PGRST116), skipping command_id in assistant message`);
        } else {
          // Real database error - log it but don't add command_id to avoid invalid foreign key
          console.error(`❌ Database error checking command ${commandId}:`, commandCheckError);
          console.warn(`⚠️ Skipping command_id in assistant message due to database error (cannot verify existence)`);
        }
      } else if (commandExists) {
        assistantMessageObj.command_id = commandId;
      } else {
        console.warn(`⚠️ Command ${commandId} does not exist in database, skipping command_id in assistant message`);
      }
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
  } catch (error: any) {
    // If this is a SKIP_DATABASE error, re-throw it so it can be handled by the caller
    if (error.code === 'SKIP_DATABASE') {
      console.log(`🔄 Re-throwing SKIP_DATABASE error to be handled by caller`);
      throw error;
    }
    // For any other error, log and return null
    console.error('Error al guardar mensajes en la base de datos:', error);
    return null;
  }
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
      // Si tenemos ambos, email y phone, generar variantes del teléfono para búsqueda más flexible
      const phoneVariants = normalizePhoneForSearch(phone);
      const phoneQueries = phoneVariants.map(variant => `phone.eq."${variant}"`);
      const allQueries = [`email.eq.${email}`, ...phoneQueries];
      query = query.or(allQueries.join(','));
      console.log(`🔍 Buscando lead con email="${email}" O phone en variantes: ${phoneVariants.join(', ')}`);
    } else {
      // Si solo tenemos uno de los dos, usar el operador eq correspondiente
      if (email) {
        query = query.eq('email', email);
        console.log(`🔍 Buscando lead con email="${email}"`);
      }
      
      if (phone) {
        // Generar variantes del número de teléfono para búsqueda más flexible
        const phoneVariants = normalizePhoneForSearch(phone);
        if (phoneVariants.length > 1) {
          const phoneQueries = phoneVariants.map(variant => `phone.eq."${variant}"`);
          query = query.or(phoneQueries.join(','));
          console.log(`🔍 Buscando lead con phone en variantes: ${phoneVariants.join(', ')}`);
        } else if (phoneVariants.length === 1) {
          // En Supabase el eq no siempre funciona bien con caracteres especiales (como + o espacios) 
          // cuando se combina con or(). En or(), hemos añadido comillas. 
          // Aquí podemos mantener eq() normal o usar filter() si hay problemas, pero eq() 
          // directo en Supabase SDK habitualmente escapa bien los valores internamente.
          query = query.eq('phone', phoneVariants[0]);
          console.log(`🔍 Buscando lead con phone="${phoneVariants[0]}"`);
        } else {
          console.log(`⚠️ No se pudieron generar variantes válidas para el teléfono: ${phone}`);
        }
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

// Función para crear una tarea para un lead
async function createTaskForLead(leadId: string, siteId?: string, userId?: string, commandId?: string): Promise<string | null> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`❌ ID de lead no válido para crear tarea: ${leadId}`);
      return null;
    }
    
    console.log(`✏️ Creando tarea para lead: ${leadId}`);
    
    // Obtener información del lead para usar en la tarea
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('id, name, user_id, site_id')
      .eq('id', leadId)
      .single();
    
    if (leadError || !lead) {
      if (leadError && leadError.code === 'PGRST116') {
        console.log(`⚠️ Lead ${leadId} no encontrado para crear tarea. Saltando creación de tarea.`);
      } else {
        console.error(`❌ Error al obtener información del lead para la tarea:`, leadError || 'Lead no encontrado');
      }
      return null;
    }
    
    // Preparar datos para la tarea
    const taskData: any = {
      lead_id: leadId,
      title: `Seguimiento para ${lead.name}`,
      type: 'follow_up',
      stage: 'pending',
      status: 'active',
      // Programar seguimiento para el siguiente día hábil (aquí usamos +1 día)
      scheduled_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      description: `Tarea de seguimiento creada automáticamente para el lead generado vía chat web.`,
    };
    
    // Priorizar los IDs proporcionados, pero usar los del lead como respaldo
    taskData.user_id = userId || lead.user_id;
    taskData.site_id = siteId || lead.site_id;
    
    // Añadir command_id si está presente y es válido
    if (commandId && isValidUUID(commandId)) {
      taskData.command_id = commandId;
    }
    
    console.log(`📋 Datos para la tarea:`, JSON.stringify(taskData));
    
    // Insertar la tarea en la base de datos
    const { data: task, error: taskError } = await supabaseAdmin
      .from('tasks')
      .insert([taskData])
      .select()
      .single();
    
    if (taskError) {
      console.error(`❌ Error al crear tarea para lead:`, taskError);
      return null;
    }
    
    console.log(`✅ Tarea creada exitosamente con ID: ${task.id}`);
    return task.id;
  } catch (error) {
    console.error(`❌ Excepción al crear tarea para lead:`, error);
    return null;
  }
}



// Función para crear un nuevo lead
async function createLead(name: string, email?: string, phone?: string, siteId?: string, visitorId?: string, origin?: string): Promise<string | null> {
  try {
    // Validar que tengamos al menos la información básica necesaria
    if (!name) {
      console.error('❌ No se puede crear un lead sin nombre');
      return null;
    }
    
    console.log(`➕ Creando nuevo lead con name=${name}, email=${email || 'N/A'}, phone=${phone || 'N/A'}, site_id=${siteId || 'N/A'}, visitor_id=${visitorId || 'N/A'}, origin=${origin || 'chat'}`);
    
    // Crear objeto con datos mínimos
    const leadData: any = {
      name: name,
      status: 'contacted',
      origin: origin || 'chat'
    };
    
    // Agregar campos opcionales si están presentes
    if (email) leadData.email = email;
    if (phone) {
      // Normalizar el teléfono para almacenamiento consistente
      const normalizedPhone = normalizePhoneForStorage(phone);
      leadData.phone = normalizedPhone;
      console.log(`📞 Teléfono normalizado para almacenamiento: "${phone}" -> "${normalizedPhone}"`);
    }
    
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
function corsHeaders(request: Request) {
  // Obtener el origen de la solicitud
  const origin = request.headers.get('origin') || '*';
  
  // Debug para identificar el origen exacto
  console.log(`[CORS-HEADERS] Setting Access-Control-Allow-Origin to: ${origin}`);
  
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version',
    'Access-Control-Allow-Credentials': 'true',
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
    
    // Obtener información de ubicación y tiempo del request
    const requestTimestamp = new Date().toISOString();
    const clientIP = request.headers.get('x-forwarded-for') || 
                    request.headers.get('x-real-ip') || 
                    request.headers.get('x-client-ip') || 
                    request.headers.get('cf-connecting-ip') || 
                    'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const acceptLanguage = request.headers.get('accept-language') || 'unknown';
    
    console.log(`⏰ Request Info - Timestamp: ${requestTimestamp}, IP: ${clientIP}, User-Agent: ${userAgent}`);
    
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
      phone,
      website_chat_origin, // Nuevo parámetro para indicar si el origen es "website_chat"
      lead_notification, // Nuevo parámetro para indicar si se debe enviar una notificación por email
      origin, // Nuevo parámetro para indicar el canal de origen: 'website', 'email', 'whatsapp'
      origin_message_id // Parámetro opcional que se agrega como metadata al message del user
    } = body;
    
    /**
     * Parámetros de la API:
     * - conversationId: UUID opcional de la conversación (si ya existe)
     * - userId: UUID opcional del usuario que envía el mensaje
     * - message: Texto del mensaje a procesar (requerido)
     * - agentId: UUID opcional del agente que procesará el mensaje
     * - site_id: UUID opcional del sitio asociado
     * - lead_id: UUID opcional del lead asociado
     * - visitor_id: UUID opcional del visitante que envía el mensaje
     * - name: Nombre opcional del contacto/lead
     * - email: Email opcional del contacto/lead
     * - phone: Teléfono opcional del contacto/lead
     * - website_chat_origin: Booleano opcional que indica si el origen es un chat web
     *   Cuando website_chat_origin=true:
     *   1. El lead creado tendrá "website_chat" como origen en lugar de "chat"
     *   2. Se creará automáticamente una tarea de seguimiento para el lead
     * - lead_notification: String opcional que indica el tipo de notificación a enviar
     *   Valores posibles: "email", "none"
     *   NOTA: La funcionalidad de email fue removida
     * - origin: String opcional que indica el canal de origen de la conversación
     *   Valores posibles: "website", "email", "whatsapp"
     *   Se establece en conversation.custom_data.channel y en lead/visitor.origin
     * - origin_message_id: String opcional que se agrega como metadata al message del user
     *   Se almacena en message.custom_data.origin_message_id
     */
    
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
    
    // Check for duplicate origin_message_id before processing
    if (origin_message_id) {
      const duplicateCheck = await checkDuplicateOriginMessage(
        origin_message_id,
        conversationId,
        lead_id,
        site_id
      );
      
      if (duplicateCheck.isDuplicate) {
        console.log(`⚠️ [DUPLICATE_CHECK] Message with origin_message_id ${origin_message_id} already processed and responded to. Skipping duplicate.`);
        return NextResponse.json(
          {
            success: true,
            message_id: duplicateCheck.existingMessageId,
            conversation_id: duplicateCheck.conversationId,
            skipped: 'duplicate',
            reason: 'Message with this origin_message_id already exists and was responded to'
          },
          { status: 200 }
        );
      }
    }
    
    // Validar el parámetro origin si está presente
    const validOrigins = ['website', 'email', 'whatsapp', 'chat', 'website_chat', 'none', 'api'];
    
    // Si no se proporciona origin pero hay header origin, usar 'website' automáticamente
    let effectiveOrigin = origin;
    if (!effectiveOrigin && request.headers.get('origin')) {
      effectiveOrigin = 'website';
      console.log(`🌐 No se proporcionó origin, pero se detectó header origin. Estableciendo automáticamente: ${effectiveOrigin}`);
    }
    
    if (effectiveOrigin && !validOrigins.includes(effectiveOrigin)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: `origin must be one of: ${validOrigins.join(', ')}` } },
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
    
    // Determinar el origen del lead basado en los parámetros
    let leadOrigin = 'chat'; // valor por defecto
    
    if (effectiveOrigin) {
      // Si se proporciona 'origin', usarlo directamente
      leadOrigin = effectiveOrigin;
      console.log(`🏷️ Origen del lead establecido desde 'origin': ${leadOrigin}`);
    } else if (website_chat_origin === true) {
      // Si website_chat_origin=true, usar 'website_chat' (para mantener compatibilidad)
      leadOrigin = 'website_chat';
      console.log(`🏷️ Origen del lead establecido desde 'website_chat_origin': ${leadOrigin}`);
    }
    
    console.log(`🏷️ Origen final del lead: ${leadOrigin}`);
    
    // Variables para gestión de lead y conversación
    let effectiveLeadId: string | null = null;
    let isNewLead = false;
    let taskId: string | null = null;
    let effectiveConversationId = conversationId;
    
    // Manejo especial para WhatsApp
    if (leadOrigin === 'whatsapp' && phone && effectiveSiteId) {
      console.log(`📱 Detectado origen WhatsApp - usando WhatsAppLeadService`);
      
      try {
        const whatsappResult = await WhatsAppLeadService.findOrCreateLeadAndConversation({
          phoneNumber: phone,
          senderName: name,
          siteId: effectiveSiteId,
          userId: userId,
          businessAccountId: body.businessAccountId // Usar businessAccountId si está disponible
        });
        
        effectiveLeadId = whatsappResult.leadId;
        isNewLead = whatsappResult.isNewLead;
        
        // Si encontramos una conversación de WhatsApp reciente, usarla
        if (whatsappResult.conversationId && !conversationId) {
          effectiveConversationId = whatsappResult.conversationId;
          console.log(`💬 Usando conversación de WhatsApp existente: ${effectiveConversationId}`);
        }
        
        // Para WhatsApp no creamos tareas automáticamente como en website_chat
        console.log(`📱 WhatsApp lead management completed - Lead: ${effectiveLeadId}, Conversation: ${effectiveConversationId || 'nueva'}`);
        
      } catch (error) {
        console.error(`❌ Error en WhatsAppLeadService:`, error);
        // Fallback al servicio estándar
        console.log(`🔄 Usando servicio estándar como fallback`);
        const leadManagementResult = await manageLeadCreation({
          leadId: lead_id,
          name,
          email,
          phone,
          siteId: effectiveSiteId,
          visitorId: visitor_id,
          origin: leadOrigin,
          createTask: false
        });
        
        effectiveLeadId = leadManagementResult.leadId;
        isNewLead = leadManagementResult.isNewLead;
        taskId = leadManagementResult.taskId;
      }
    } else {
      // Gestionar lead_id utilizando el servicio estándar para otros orígenes
      const leadManagementResult = await manageLeadCreation({
        leadId: lead_id,
        name,
        email,
        phone,
        siteId: effectiveSiteId,
        visitorId: visitor_id,
        origin: leadOrigin,
        createTask: website_chat_origin === true
      });
      
      effectiveLeadId = leadManagementResult.leadId;
      isNewLead = leadManagementResult.isNewLead;
      taskId = leadManagementResult.taskId;
    }
    
    // Verificar si tenemos un lead_id efectivo después de la gestión
    if (effectiveLeadId) {
      console.log(`👤 Usando lead_id: ${effectiveLeadId} para esta conversación. Es nuevo: ${isNewLead}`);
      if (taskId) {
        console.log(`✅ Tarea creada para el lead con ID: ${taskId}`);
      }
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

    // Buscar conversación existente si no se proporcionó una y no es WhatsApp ni website_chat
    if (!effectiveConversationId && leadOrigin !== 'whatsapp' && leadOrigin !== 'website_chat') {
      console.log(`🔍 Buscando conversación existente para origen "${effectiveOrigin || leadOrigin}"`);
      
      const existingConversationId = await ConversationService.findExistingConversation(
        effectiveLeadId || undefined,
        visitor_id,
        effectiveSiteId,
        effectiveOrigin || leadOrigin,
        phone,
        email
      );
      
      if (existingConversationId) {
        effectiveConversationId = existingConversationId;
        console.log(`✅ Usando conversación existente encontrada: ${effectiveConversationId}`);
      } else {
        console.log(`📝 No se encontró conversación existente, se creará una nueva`);
      }
    } else if (!effectiveConversationId && leadOrigin === 'website_chat') {
      console.log(`🌐 Para website_chat sin conversation_id, siempre se creará una nueva conversación`);
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
    let contextMessage = `${message}`;
    
    // Agregar información del request al contexto
    contextMessage += `\n\nRequest Information:`;
    contextMessage += `\nTimestamp: ${requestTimestamp}`;
    contextMessage += `\nClient IP: ${clientIP}`;
    contextMessage += `\nUser Agent: ${userAgent}`;
    contextMessage += `\nLanguage: ${acceptLanguage}`;
    if (effectiveOrigin) {
      contextMessage += `\nChannel: ${effectiveOrigin}`;
    }
    
    // Obtener y añadir información completa del lead al contexto si está disponible
    if (effectiveLeadId) {
      console.log(`📋 Obteniendo información completa del lead para el contexto: ${effectiveLeadId}`);
      const leadInfo = await getLeadInfo(effectiveLeadId);
      
      if (leadInfo) {
        contextMessage += "\n\nLead Information:";
        contextMessage += `\nLead ID: ${leadInfo.id}`;
        contextMessage += `\nName: ${leadInfo.name || 'N/A'}`;
        contextMessage += `\nEmail: ${leadInfo.email || 'N/A'}`;
        contextMessage += `\nPhone: ${leadInfo.phone || 'N/A'}`;
        
        // Manejar el campo company correctamente
        let companyDisplay = 'N/A';
        if (leadInfo.company) {
          if (typeof leadInfo.company === 'string') {
            companyDisplay = leadInfo.company;
          } else if (typeof leadInfo.company === 'object' && leadInfo.company.name) {
            companyDisplay = leadInfo.company.name;
          } else if (typeof leadInfo.company === 'object') {
            // Verificar si el objeto está vacío
            const objectKeys = Object.keys(leadInfo.company);
            if (objectKeys.length === 0) {
              companyDisplay = 'N/A';
            } else {
              // Si es un objeto sin campo name, intentar otros campos comunes
              companyDisplay = leadInfo.company.company_name || 
                             leadInfo.company.businessName || 
                             leadInfo.company.title || 
                             leadInfo.company.organization || 
                             leadInfo.company.business_name;
              
              // Si no se encontró ningún campo válido, usar N/A
              if (!companyDisplay) {
                companyDisplay = 'N/A';
              }
            }
          }
        }
        contextMessage += `\nCompany: ${companyDisplay}`;
        
        contextMessage += `\nStatus: ${leadInfo.status || 'N/A'}`;
        contextMessage += `\nOrigin: ${leadInfo.origin || 'N/A'}`;
        contextMessage += `\nLead Score: ${leadInfo.lead_score || 'N/A'}`;
        contextMessage += `\nSource: ${leadInfo.source || 'N/A'}`;
        
        // Agregar información adicional si está disponible
        if (leadInfo.contact_info) {
          try {
            const contactInfo = typeof leadInfo.contact_info === 'string' 
              ? JSON.parse(leadInfo.contact_info) 
              : leadInfo.contact_info;
            if (contactInfo && Object.keys(contactInfo).length > 0) {
              contextMessage += `\nAdditional Contact Info: ${JSON.stringify(contactInfo)}`;
            }
          } catch (e) {
            console.log('⚠️ Error parsing contact_info for context');
          }
        }
        
        if (leadInfo.notes) {
          contextMessage += `\nNotes: ${leadInfo.notes}`;
        }
        
        console.log(`✅ Información completa del lead agregada al contexto`);
      } else {
        // Si no pudimos obtener la información completa del lead, usar los parámetros de la request como respaldo
        console.log(`⚠️ No se pudo obtener información completa del lead, usando parámetros de la request como respaldo`);
        contextMessage += "\n\nLead Information (from request):";
        contextMessage += `\nLead ID: ${effectiveLeadId}`;
        if (name) contextMessage += `\nName: ${name}`;
        if (email) contextMessage += `\nEmail: ${email}`;
        if (phone) contextMessage += `\nPhone: ${phone}`;
      }
    } else if (name || email || phone) {
      // Si no tenemos effectiveLeadId pero sí información de contacto de la request
      console.log(`📋 No hay lead_id efectivo, pero usando información de contacto disponible de la request`);
      contextMessage += "\n\nContact Information (no lead created yet):";
      if (name) contextMessage += `\nName: ${name}`;
      if (email) contextMessage += `\nEmail: ${email}`;
      if (phone) contextMessage += `\nPhone: ${phone}`;
    }
    
    if (effectiveConversationId && isValidUUID(effectiveConversationId)) {
      console.log(`🔄 Recuperando historial para la conversación: ${effectiveConversationId}`);
      const historyMessages = await ConversationService.getConversationHistory(effectiveConversationId);
      
      if (historyMessages && historyMessages.length > 0) {
        // Filter out any messages that might be duplicates of the current message
        // This prevents the current message from appearing twice in the context
        const filteredMessages = historyMessages.filter((msg: {role: string, content: string}) => {
          // No filtrar mensajes de asistente o team_member
          if (msg.role === 'assistant' || msg.role === 'team_member' || msg.role === 'system') {
            return true;
          }
          // Para mensajes de usuario o visitante, comparar el contenido
          return msg.content.trim() !== message.trim();
        });
        
        if (filteredMessages.length > 0) {
          const conversationHistory = ConversationService.formatConversationHistoryForContext(filteredMessages);
          contextMessage = `${contextMessage}\n\nConversation History:\n${conversationHistory}\n\nConversation ID: ${effectiveConversationId}`;
          console.log(`📜 Historial de conversación recuperado con ${filteredMessages.length} mensajes`);
        } else {
          contextMessage = `${contextMessage}\nConversation ID: ${effectiveConversationId}`;
        }
      } else {
        contextMessage = `${contextMessage}\nConversation ID: ${effectiveConversationId}`;
        console.log(`⚠️ No se encontró historial para la conversación: ${effectiveConversationId}`);
      }
    }
    
    // Create the command using CommandFactory with the conversation history in the context
    // Lead Qualification Policy & Tool Usage (for support):
    contextMessage += `\n\n=== LEAD QUALIFICATION POLICY ===\n`;
    contextMessage += `Customer Support can update lead status when conversations clearly change the sales stage.\n`;
    contextMessage += `- contacted → first meaningful two-way interaction.\n`;
    contextMessage += `- qualified → ICP fit + explicit interest or handoff to sales after a successful discovery.\n`;
    contextMessage += `- converted → payment received or contract signed (only if verified).\n`;
    contextMessage += `- lost → explicit rejection, competitor chosen, or no response after agreed cadence.\n`;
    contextMessage += `Use QUALIFY_LEAD with: site_id, status, and one identifier (lead_id | email | phone). Add notes briefly explaining the change.\n`;

    const command = CommandFactory.createCommand({
      task: 'create message',
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      // Add site_id as a basic property if it exists
      ...(effectiveSiteId ? { site_id: effectiveSiteId } : {}),
      // Add lead_id as a basic property if it exists
      ...(effectiveLeadId ? { lead_id: effectiveLeadId } : {}),
      description: 'Respond helpfully to the customer inquiries about your business.',
      // Set the target as a message with content
      targets: [
        {
          message: {
            content: "message example", // Will be filled by the agent
            is_robot: false, // Set to true if this is a robot/automated interaction that should not be saved to DB
            is_transactional_message: false, // Set to true if this is a transactional/automatic message that should not be saved to DB
            is_erratic: false // Set to true if the message is nonsensical or makes no sense and should not be saved to DB
          }
        },
        {
          conversation: {
            title: "conversation title", // Will be filled by the agent
            is_robot: false, // Set to true if this conversation is with a robot/bot and should not be saved to DB
            is_transactional_message: false, // Set to true if this is a transactional conversation that should not be saved to DB
            is_erratic: false // Set to true if the conversation is nonsensical and should not be saved to DB
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
            name: 'QUALIFY_LEAD',
            description: 'Qualify or update lead status based on conversation outcome and company policy',
            parameters: {
              type: 'object',
              properties: {
                site_id: {
                  type: 'string',
                  description: 'Site UUID where the lead belongs (required)',
                  ...(effectiveSiteId ? { enum: [effectiveSiteId] } : {})
                },
                lead_id: {
                  type: 'string',
                  description: 'Lead UUID to qualify (one of lead_id, email, or phone is required)'
                },
                email: {
                  type: 'string',
                  description: 'Lead email as alternative identifier'
                },
                phone: {
                  type: 'string',
                  description: 'Lead phone as alternative identifier'
                },
                status: {
                  type: 'string',
                  enum: ['contacted', 'qualified', 'converted', 'lost'],
                  description: 'New lead status according to company rules'
                },
                notes: {
                  type: 'string',
                  description: 'Short reasoning for the qualification change'
                }
              },
              required: ['site_id', 'status'],
              oneOf: [
                { required: ['lead_id'] },
                { required: ['email'] },
                { required: ['phone'] }
              ],
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
          agent_role: 'sales',
          status: 'not_initialized'
        },
        {
          agent_role: 'manager',
          status: 'not_initialized'
        }
      ],
      // Set model for customer support
      // Use GPT-5-mini with minimal reasoning effort for deep thinking
      modelType: 'openai',
      modelId: 'gpt-5.2',
      reasoningEffort: 'minimal',
      verbosity: 'low',
      // Add tools-specific model
      toolsModelType: 'openai',
      toolsModelId: 'gpt-4o'
    });
    
    // Submit the command for processing
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
    console.log(`[CustomerSupport] Using GPT-5-mini for responses, GPT-4o for tools`);
    
    // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
    let initialDbUuid = await getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
    } else {
      console.warn(`⚠️ No se pudo obtener UUID inicialmente, esperando a que el comando se complete...`);
    }
    
    // Validar y reintentar si no se obtuvo un UUID válido
    if (!initialDbUuid || !isValidUUID(initialDbUuid)) {
      console.error(`❌ Failed to retrieve valid database UUID for command ${internalCommandId}`);
      // Additional retry logic
      await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms
      const retryUuid = await getCommandDbUuid(internalCommandId);
      if (retryUuid && isValidUUID(retryUuid)) {
        initialDbUuid = retryUuid;
        console.log(`✅ Retry successful: ${initialDbUuid}`);
      }
    }
    
    // Esperar a que el comando se complete utilizando nuestra función
    const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
    
    // CRITICAL: Verify command completed successfully BEFORE processing results
    // This check must run regardless of UUID validity
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
            site_id: effectiveSiteId,
            command_id: internalCommandId
          }
        },
        { 
          status: 500,
          headers: corsHeaders(request)
        }
      );
    }
    
    // Usar el UUID obtenido inicialmente si no tenemos uno válido después de la ejecución
    let effectiveDbUuid: string | null | undefined = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
    
    // Verificar que tenemos un UUID de base de datos válido
    if (!effectiveDbUuid || !isValidUUID(effectiveDbUuid)) {
      console.error(`❌ No se pudo obtener un UUID válido de la base de datos para el comando ${internalCommandId}`);
      console.error(`❌ effectiveDbUuid recibido: ${effectiveDbUuid}`);
      console.error(`❌ dbUuid from completion: ${dbUuid}`);
      console.error(`❌ initialDbUuid: ${initialDbUuid}`);
      
      // Set to undefined to prevent passing invalid UUID to saveMessages
      // This will cause saveMessages to skip adding command_id, which is safer than passing invalid ID
      const invalidUuid = effectiveDbUuid;
      effectiveDbUuid = undefined;
      console.log(`⚠️ Setting effectiveDbUuid to undefined to prevent foreign key errors. Original value was: ${invalidUuid}`);
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
      
      // Buscar mensajes en los resultados - enfocado específicamente en la estructura de customer support
      console.log(`🔍 Buscando mensaje del asistente en los resultados...`);
      
      // Formato específico para customer support: { message: { content: string } }
      const messageResults = executedCommand.results.filter((r: any) => 
        r.message && typeof r.message === 'object' && r.message.content && typeof r.message.content === 'string'
      );
      console.log(`📝 Resultados con estructura message.content: ${messageResults.length}`);
      
      if (messageResults.length > 0) {
        assistantMessage = messageResults[0].message.content;
        console.log(`✅ Mensaje extraído: ${assistantMessage.substring(0, 100)}...`);
      } else {
        // Log para debugging si no se encuentra la estructura esperada
        console.log(`⚠️ No se encontró la estructura esperada { message: { content: string } }`);
        console.log(`📋 Estructuras encontradas:`, executedCommand.results.map((r: any, i: number) => {
          return `Resultado ${i}: ${Object.keys(r).join(',')}`
        }).join(' | '));
        
        // Fallback muy conservador: solo si hay exactamente 1 resultado y es un string directo
        if (executedCommand.results.length === 1 && typeof executedCommand.results[0] === 'string') {
          assistantMessage = executedCommand.results[0];
          console.log(`⚠️ Usando fallback para string directo: ${assistantMessage.substring(0, 100)}...`);
        } else {
          console.log(`❌ No se pudo extraer mensaje - estructura no reconocida para customer support`);
          console.log(`📋 Estructura completa de results:`, JSON.stringify(executedCommand.results, null, 2));
        }
      }
    }
    
    console.log(`💬 Mensaje del asistente: ${assistantMessage.substring(0, 50)}...`);
    
    // Extraer flags is_robot, is_transactional_message e is_erratic de los resultados
    let isRobot: boolean | undefined = undefined;
    let isTransactionalMessage: boolean | undefined = undefined;
    let isErratic: boolean | undefined = undefined;
    
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      // Buscar flags en message target
      const messageResult = executedCommand.results.find((r: any) => 
        r.message && typeof r.message === 'object'
      );
      if (messageResult && messageResult.message) {
        if (typeof messageResult.message.is_robot === 'boolean') {
          isRobot = messageResult.message.is_robot;
          console.log(`🤖 Flag is_robot encontrado en message: ${isRobot}`);
        }
        if (typeof messageResult.message.is_transactional_message === 'boolean') {
          isTransactionalMessage = messageResult.message.is_transactional_message;
          console.log(`📧 Flag is_transactional_message encontrado en message: ${isTransactionalMessage}`);
        }
        if (typeof messageResult.message.is_erratic === 'boolean') {
          isErratic = messageResult.message.is_erratic;
          console.log(`⚠️ Flag is_erratic encontrado en message: ${isErratic}`);
        }
      }
      
      // Buscar flags en conversation target
      const conversationResult = executedCommand.results.find((r: any) => 
        r.conversation && typeof r.conversation === 'object'
      );
      if (conversationResult && conversationResult.conversation) {
        if (typeof conversationResult.conversation.is_robot === 'boolean') {
          isRobot = conversationResult.conversation.is_robot;
          console.log(`🤖 Flag is_robot encontrado en conversation: ${isRobot}`);
        }
        if (typeof conversationResult.conversation.is_transactional_message === 'boolean') {
          isTransactionalMessage = conversationResult.conversation.is_transactional_message;
          console.log(`📧 Flag is_transactional_message encontrado en conversation: ${isTransactionalMessage}`);
        }
        if (typeof conversationResult.conversation.is_erratic === 'boolean') {
          isErratic = conversationResult.conversation.is_erratic;
          console.log(`⚠️ Flag is_erratic encontrado en conversation: ${isErratic}`);
        }
      }
    }
    
    // Usando lead_id efectivo al guardar los mensajes
    // Envolver en try-catch para manejar error SKIP_DATABASE
    let savedMessages;
    try {
      savedMessages = await saveMessages(
        effectiveUserId, 
        message, 
        assistantMessage, 
        effectiveConversationId, 
        conversationTitle, 
        effectiveLeadId || undefined, 
        visitor_id, 
        effectiveAgentId, 
        effectiveSiteId, 
        (effectiveDbUuid && isValidUUID(effectiveDbUuid)) ? effectiveDbUuid : undefined,
        effectiveOrigin || (leadOrigin !== 'chat' ? leadOrigin : undefined), // Usar origin si está disponible, o leadOrigin si no es 'chat'
        isRobot,
        isTransactionalMessage,
        isErratic,
        origin_message_id
      );
    } catch (error: any) {
      // Si el error es SKIP_DATABASE, retornar respuesta sin crear objetos en DB
      if (error.code === 'SKIP_DATABASE' && error.results) {
        console.log(`🚨 SKIP_DATABASE detectado - retornando resultados sin crear objetos en DB`);
        return NextResponse.json(
          { 
            success: true, 
            data: { 
              command_id: effectiveDbUuid,
              skip_database: true,
              results: {
                message: error.results.message || assistantMessage,
                conversation_title: error.results.conversation_title || conversationTitle,
                is_robot: error.results.is_robot || false,
                is_transactional_message: error.results.is_transactional_message || false,
                is_erratic: error.results.is_erratic || false
              },
              lead_id: effectiveLeadId || null,
              task_id: taskId || null,
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
            headers: corsHeaders(request)
          }
        );
      }
      // Si es otro error, relanzarlo
      throw error;
    }
    
    if (!savedMessages) {
      console.error(`❌ Error al guardar mensajes en la base de datos`);
      console.error(`❌ Context: command_id=${effectiveDbUuid}, lead_id=${effectiveLeadId}, conversation_id=${effectiveConversationId}`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATABASE_ERROR', 
            message: 'The command completed successfully but the messages could not be saved to the database. This may be due to a foreign key constraint failure, missing required data, or database connection issue. Check server logs for details.',
            details: 'saveMessages() returned null instead of saved messages. Possible causes: invalid foreign key references (command_id, lead_id, conversation_id), database constraint violations, or connection errors.'
          },
          data: {
            command_id: effectiveDbUuid,
            message: assistantMessage,
            conversation_title: conversationTitle,
            lead_id: effectiveLeadId || null,
            conversation_id: effectiveConversationId || null
          },
          debug: {
            agent_id: effectiveAgentId,
            user_id: effectiveUserId,
            agent_user_id: agentUserId,
            site_id: effectiveSiteId,
            is_robot: isRobot,
            is_transactional: isTransactionalMessage,
            is_erratic: isErratic
          }
        },
        { 
          status: 500,
          headers: corsHeaders(request)
        }
      );
    }
    
    // Notificación por email removida - se eliminó sendLeadNotificationEmail
    
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: effectiveDbUuid,
          conversation_id: savedMessages.conversationId,
          conversation_title: savedMessages.conversationTitle,
          lead_id: effectiveLeadId || null,
          task_id: taskId || null,
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
        headers: corsHeaders(request)
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

export async function OPTIONS(request: Request) {
  console.log("[CORS-PREFLIGHT] Handling OPTIONS request");
  
  // Obtener el origen de la solicitud
  const origin = request.headers.get('origin') || '*';
  console.log(`[CORS-PREFLIGHT] Request origin: ${origin}`);
  
  // Para seguir el mismo comportamiento del middleware, verificar si el origen está permitido
  const isAllowed = true; // Aquí podrías implementar la misma lógica de cors.config.js
  
  // Crear respuesta preflight
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request)
  });
}