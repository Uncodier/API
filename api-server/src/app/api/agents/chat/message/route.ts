import { NextResponse } from 'next/server';
import { CommandFactory, AgentInitializer } from '@/lib/agentbase';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Inicializar el agente y obtener el servicio de comandos
const agentInitializer = AgentInitializer.getInstance();
agentInitializer.initialize();
const commandService = agentInitializer.getCommandService();

// ID fijo para usuarios anónimos/invitados que debe existir en la base de datos
const ANONYMOUS_USER_ID = "00000000-0000-0000-0000-000000000000"; // El ID real del usuario anónimo en tu sistema

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
    try {
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
async function saveMessages(userId: string, userMessage: string, assistantMessage: string, conversationId?: string, leadId?: string, visitorId?: string) {
  try {
    // Verificar si tenemos un ID de conversación
    if (!conversationId) {
      // Crear una nueva conversación si no existe
      const conversationData: any = { user_id: userId };
      
      // Añadir lead_id y visitor_id si están presentes
      if (leadId) conversationData.lead_id = leadId;
      if (visitorId) conversationData.visitor_id = visitorId;
      
      const { data: conversation, error: convError } = await supabaseAdmin
        .from('conversations')
        .insert([conversationData])
        .select()
        .single();
      
      if (convError) {
        console.error('Error al crear conversación:', convError);
        return null;
      }
      
      conversationId = conversation.id;
      console.log(`🗣️ Nueva conversación creada con ID: ${conversationId}`);
    }
    
    // Guardar el mensaje del usuario
    const userMessageData: any = {
      conversation_id: conversationId,
      user_id: userId,
      content: userMessage,
      role: 'user'
    };
    
    // Añadir lead_id y visitor_id si están presentes
    if (leadId) userMessageData.lead_id = leadId;
    if (visitorId) userMessageData.visitor_id = visitorId;
    
    const { data: savedUserMessage, error: userMsgError } = await supabaseAdmin
      .from('messages')
      .insert([userMessageData])
      .select()
      .single();
    
    if (userMsgError) {
      console.error('Error al guardar mensaje del usuario:', userMsgError);
      return null;
    }
    
    console.log(`💾 Mensaje del usuario guardado con ID: ${savedUserMessage.id}`);
    
    // Guardar el mensaje del asistente
    const assistantMessageData: any = {
      conversation_id: conversationId,
      content: assistantMessage,
      role: 'assistant'
    };
    
    const { data: savedAssistantMessage, error: assistantMsgError } = await supabaseAdmin
      .from('messages')
      .insert([assistantMessageData])
      .select()
      .single();
    
    if (assistantMsgError) {
      console.error('Error al guardar mensaje del asistente:', assistantMsgError);
      return null;
    }
    
    console.log(`💾 Mensaje del asistente guardado con ID: ${savedAssistantMessage.id}`);
    
    return {
      conversationId,
      userMessageId: savedUserMessage.id,
      assistantMessageId: savedAssistantMessage.id
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
    
    // Formatear los mensajes para el contexto del comando
    const formattedMessages = data.map(msg => {
      // Determinar el rol según los campos disponibles
      let role = 'user';
      
      if (msg.role) {
        // Si el campo role existe, usarlo directamente
        role = msg.role;
      } else if (msg.sender_type) {
        // Si existe sender_type, hacer la conversión
        role = msg.sender_type === 'visitor' || msg.sender_type === 'user' ? 'user' : 'assistant';
      } else if (!msg.user_id) {
        // Si no hay user_id, asumimos que es asistente
        role = 'assistant';
      }
      
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
    const roleDisplay = msg.role === 'user' ? 'USER' : 'ASSISTANT';
    formattedHistory += `[${index + 1}] ${roleDisplay}: ${msg.content.trim()}\n`;
    
    // Add a separator between messages for better readability
    if (index < messages.length - 1) {
      formattedHistory += '---\n';
    }
  });
  
  formattedHistory += '```';
  return formattedHistory;
}

// Función para obtener la información del agente desde la base de datos
async function getAgentInfo(agentId: string): Promise<{ user_id: string; site_id?: string; tools?: any[]; activities?: any[] } | null> {
  try {
    if (!isValidUUID(agentId)) {
      console.error(`ID de agente no válido: ${agentId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información del agente: ${agentId}`);
    
    // Consultar el agente en la base de datos
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('user_id, site_id, configuration')
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
    
    // Parse configuration if it's a string
    let config = data.configuration;
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      } catch (e) {
        console.error('Error parsing agent configuration:', e);
        config = {};
      }
    }
    
    // Ensure config is an object
    config = config || {};
    
    // Extract tools and activities from configuration if available
    const tools = Array.isArray(config.tools) ? config.tools : [];
    const activities = Array.isArray(config.activities) ? config.activities : [];
    
    console.log(`✅ Información del agente recuperada: user_id=${data.user_id}, site_id=${data.site_id || 'N/A'}`);
    console.log(`📦 Tools: ${tools.length}, Activities: ${activities.length}`);
    
    return {
      user_id: data.user_id,
      site_id: data.site_id,
      tools,
      activities
    };
  } catch (error) {
    console.error('Error al obtener información del agente:', error);
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extract parameters from the request
    const { conversationId, message, agentId, lead_id, visitor_id, site_id: requestSiteId } = body;
    
    // Validate required parameters
    if (!message) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'message is required' } },
        { status: 400 }
      );
    }
    
    if (!agentId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'agentId is required' } },
        { status: 400 }
      );
    }
    
    // Obtener información del agente (userId y site_id)
    const agentInfo = await getAgentInfo(agentId);
    
    if (!agentInfo) {
      return NextResponse.json(
        { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } },
        { status: 404 }
      );
    }
    
    // Usar el userId del propietario del agente
    const userId = agentInfo.user_id;
    // Use site_id from request if provided, otherwise use the one from the agent
    const site_id = requestSiteId || agentInfo.site_id;
    
    console.log(`Creando comando para agente: ${agentId}, propietario: ${userId}, site: ${site_id || 'N/A'}`);
    
    // Retrieve conversation history if a conversation ID is provided
    let contextMessage = `Current message: ${message}`;
    
    if (conversationId && isValidUUID(conversationId)) {
      console.log(`🔄 Recuperando historial para la conversación: ${conversationId}`);
      const historyMessages = await getConversationHistory(conversationId);
      
      if (historyMessages && historyMessages.length > 0) {
        // Filter out any messages that might be duplicates of the current message
        const filteredMessages = historyMessages.filter(msg => 
          msg.role !== 'user' || msg.content.trim() !== message.trim()
        );
        
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
    
    // Añadir información del lead, visitor y site al contexto si están presentes
    if (lead_id) {
      contextMessage = `${contextMessage}\nLead ID: ${lead_id}`;
    }
    
    if (visitor_id) {
      contextMessage = `${contextMessage}\nVisitor ID: ${visitor_id}`;
    }
    
    if (site_id) {
      contextMessage = `${contextMessage}\nSite ID: ${site_id}`;
    }
    
    // Define default tools in case agent doesn't have any - empty array as per specification
    const defaultTools: any[] = [];
    
    // Use agent tools if available, otherwise use default tools
    const tools = agentInfo.tools && Array.isArray(agentInfo.tools) && agentInfo.tools.length > 0 
      ? agentInfo.tools 
      : defaultTools;
      
    // Check if agent has activities
    const hasActivities = agentInfo.activities && Array.isArray(agentInfo.activities) && agentInfo.activities.length > 0;
    const activities = agentInfo.activities || [];
    
    console.log(`🔧 Using ${tools.length} tools ${tools.length > 0 ? 'from agent configuration' : '(empty array)'}`);
    if (hasActivities) {
      console.log(`🔧 Including ${activities.length} activities from agent configuration`);
    }
      
    // Create the command using CommandFactory
    const command = CommandFactory.createCommand({
      task: 'create message',
      userId,
      agentId,
      // Add site_id as a basic property if it exists
      ...(site_id ? { site_id } : {}),
      description: 'Respond helpfully to the user\'s inquiry, provide relevant insights, and assist with the requested task using available tools and knowledge.',
      // Set the target as a message with content
      targets: [
        {
          message: {
            content: "message example" // Will be filled by the agent
          }
        }
      ],
      // Use agent tools or default tools
      tools,
      // Add any activities as additional tools if they exist
      ...(hasActivities ? { activities } : {}),
      // Context includes the current message and conversation history
      context: contextMessage,
      // Add supervisors
      supervisor: [
        {
          agent_role: 'specialist',
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
    
    if (!completed || !executedCommand) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'The command did not complete successfully in the expected time' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Extraer la respuesta del asistente
    let assistantMessage = "No response generated";
    
    // Obtener resultados si existen
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      // Buscar mensajes en los resultados
      const messageResults = executedCommand.results.filter((r: any) => r.type === 'message');
      
      if (messageResults.length > 0 && messageResults[0].content) {
        assistantMessage = messageResults[0].content;
      }
    }
    
    console.log(`💬 Mensaje del asistente: ${assistantMessage.substring(0, 50)}...`);
    
    // Guardar los mensajes en la base de datos - Aseguramos que esto se complete antes de responder
    const savedMessages = await saveMessages(userId, message, assistantMessage, conversationId, lead_id, visitor_id);
    
    // Verificar que se guardaron correctamente los mensajes
    if (!savedMessages) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'MESSAGE_SAVE_FAILED', 
            message: 'The messages could not be saved correctly' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Si todo es correcto, devolvemos la respuesta exitosa después de completar todo el proceso
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          commandId: effectiveDbUuid || internalCommandId,
          status: 'completed',
          conversation_id: savedMessages.conversationId,
          messages: {
            user: {
              content: message,
              message_id: savedMessages.userMessageId
            },
            assistant: {
              content: assistantMessage,
              message_id: savedMessages.assistantMessageId
            }
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