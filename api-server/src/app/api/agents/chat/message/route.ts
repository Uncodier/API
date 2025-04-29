import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Inicializar el agente y obtener el servicio de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

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
async function saveMessages(userId: string, userMessage: string, assistantMessage: string, conversationId?: string, leadId?: string, visitorId?: string, conversationTitle?: string, agentId?: string, teamMemberId?: string, commandId?: string) {
  try {
    // Debug logs para verificar los parámetros recibidos
    console.log(`📥 saveMessages recibió: userId=${userId}, teamMemberId=${teamMemberId || 'undefined'}, commandId=${commandId || 'undefined'}`);
    
    // Log de qué rol se va a usar
    const effectiveRole = visitorId ? 'visitor' : (teamMemberId ? 'team_member' : 'user');
    console.log(`💾 Guardando mensajes - Role: ${effectiveRole}, User: ${teamMemberId || userId}`);
    
    // Verificar si tenemos un ID de conversación
    if (!conversationId) {
      // Crear una nueva conversación si no existe
      const conversationData: any = { user_id: userId };
      
      // Añadir lead_id, visitor_id y agent_id si están presentes
      if (leadId) conversationData.lead_id = leadId;
      if (visitorId) conversationData.visitor_id = visitorId;
      if (agentId) conversationData.agent_id = agentId;
      // Añadir el título si está presente
      if (conversationTitle) conversationData.title = conversationTitle;
      
      console.log(`🗣️ Creando nueva conversación con datos: ${JSON.stringify(conversationData).substring(0, 100)}...`);
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
    } else if (conversationTitle) {
      // Actualizar el título de la conversación existente si se proporciona uno nuevo
      console.log(`✏️ Actualizando título de conversación ${conversationId} a: "${conversationTitle}"`);
      const { error: updateError } = await supabaseAdmin
        .from('conversations')
        .update({ title: conversationTitle })
        .eq('id', conversationId);
      
      if (updateError) {
        console.error('Error al actualizar título de conversación:', updateError);
        // No fallamos toda la operación si solo falla la actualización del título
        console.log('Continuando con el guardado de mensajes...');
      } else {
        console.log(`✏️ Título de conversación actualizado: "${conversationTitle}"`);
      }
    }
    
    // Guardar el mensaje del usuario
    console.log(`💬 Preparando guardado del mensaje del usuario en conversación: ${conversationId}`);
    const userMessageData: any = {
      conversation_id: conversationId,
      user_id: teamMemberId || userId,
      content: userMessage,
      role: "user"
    };
    
    console.log(`📋 Datos del mensaje del usuario: user_id=${userMessageData.user_id}, role=${userMessageData.role}`);
    
    // Añadir lead_id, visitor_id y agent_id si están presentes
    if (leadId) userMessageData.lead_id = leadId;
    if (visitorId) userMessageData.visitor_id = visitorId;
    if (agentId) userMessageData.agent_id = agentId;
    if (commandId) userMessageData.command_id = commandId;
    
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
    console.log(`💬 Preparando guardado del mensaje del asistente en conversación: ${conversationId}`);
    const assistantMessageData: any = {
      conversation_id: conversationId,
      content: assistantMessage,
      role: 'assistant'
    };
    
    // Añadir lead_id, visitor_id y agent_id si están presentes
    if (leadId) assistantMessageData.lead_id = leadId;
    if (visitorId) assistantMessageData.visitor_id = visitorId;
    if (agentId) assistantMessageData.agent_id = agentId;
    if (commandId) assistantMessageData.command_id = commandId;
    
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
    
    // Verificar que los mensajes se guardaron correctamente
    console.log(`✅ Ambos mensajes guardados exitosamente para la conversación: ${conversationId}`);
    
    return {
      conversationId,
      userMessageId: savedUserMessage.id,
      assistantMessageId: savedAssistantMessage.id,
      conversationTitle,
      userRole: effectiveRole
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

// Función para obtener la información del agente desde la base de datos
async function getAgentInfo(agentId: string): Promise<{ user_id: string; site_id?: string; tools?: any[]; activities?: any[] } | null> {
  try {
    if (!isValidUUID(agentId)) {
      console.error(`ID de agente no válido: ${agentId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información del agente: ${agentId}`);
    
    // Consultar el agente en la base de datos - Specify only the columns we need
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id, site_id, configuration')
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

// Función para obtener la información del miembro del equipo
async function getTeamMemberInfo(teamMemberId: string): Promise<any | null> {
  try {
    if (!isValidUUID(teamMemberId)) {
      console.error(`ID de miembro del equipo no válido: ${teamMemberId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información del miembro del equipo: ${teamMemberId}`);
    
    // Primero obtener el email del usuario a través de la API de Auth
    const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(teamMemberId);
    
    if (userError || !userData || !userData.user || !userData.user.email) {
      console.error(`Error al obtener el email del usuario: ${userError?.message || 'Usuario no encontrado'}`);
      return null;
    }
    
    const userEmail = userData.user.email;
    console.log(`📧 Email del usuario encontrado: ${userEmail}`);
    
    // Ahora buscar el perfil usando el email del usuario
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('email', userEmail)
      .single();
    
    if (profileError) {
      console.error(`Error al obtener el perfil del usuario: ${profileError.message}`);
      return null;
    }
    
    if (!profileData) {
      console.log(`⚠️ No se encontró el perfil para el usuario con email: ${userEmail}`);
      return null;
    }
    
    console.log(`✅ Perfil recuperado para: ${profileData.name || profileData.email || userEmail}`);
    
    // Retornar el perfil directamente sin modificación
    return profileData;
  } catch (error) {
    console.error('Error al obtener información del usuario:', error);
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extract parameters from the request
    const { conversationId, message, agentId, lead_id, visitor_id, site_id, team_member_id } = body;
    
    // Log de parámetros recibidos
    console.log(`📨 Parámetros recibidos: agentId=${agentId}, team_member_id=${team_member_id || 'no proporcionado'}`);
    
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

    if (!site_id) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required' } },
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
    
    // If team_member_id is provided, use it as message owner, otherwise use agent owner's ID
    const userId = team_member_id || agentInfo.user_id;
    
    console.log(`👤 Determinación de usuario: team_member_id=${team_member_id || 'no proporcionado'}, userId asignado=${userId}`);
    console.log(`Creando comando para agente: ${agentId}, propietario: ${userId}, site: ${site_id}`);
    
    // Retrieve conversation history if a conversation ID is provided
    let contextMessage = `Current message: ${message}`;
    
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
    
    // Si hay un team_member_id, obtener toda la información disponible y añadirla al contexto
    if (team_member_id) {
      const teamMemberInfo = await getTeamMemberInfo(team_member_id);
      
      if (teamMemberInfo) {
        console.log(`✅ Añadiendo información detallada del miembro del equipo al contexto`);
        contextMessage = `${contextMessage}\n\nCurrent User data and personal information (as a team member of your company):`;
        contextMessage = `${contextMessage}\nID: ${team_member_id}`;
        
        // Añadir todos los campos disponibles del miembro del equipo
        if (teamMemberInfo.name) contextMessage = `${contextMessage}\nName: ${teamMemberInfo.name}`;
        if (teamMemberInfo.email) contextMessage = `${contextMessage}\nEmail: ${teamMemberInfo.email}`;
        if (teamMemberInfo.role) contextMessage = `${contextMessage}\nRole: ${teamMemberInfo.role}`;
        if (teamMemberInfo.department) contextMessage = `${contextMessage}\nDepartment: ${teamMemberInfo.department}`;
        if (teamMemberInfo.title) contextMessage = `${contextMessage}\nTitle: ${teamMemberInfo.title}`;
        if (teamMemberInfo.bio) contextMessage = `${contextMessage}\nBio: ${teamMemberInfo.bio}`;
        if (teamMemberInfo.avatar_url) contextMessage = `${contextMessage}\nAvatar URL: ${teamMemberInfo.avatar_url}`;
        if (teamMemberInfo.phone) contextMessage = `${contextMessage}\nPhone: ${teamMemberInfo.phone}`;
        
        // Si hay campos personalizados, también añadirlos
        if (teamMemberInfo.custom_fields && typeof teamMemberInfo.custom_fields === 'object') {
          contextMessage = `${contextMessage}\n\nCustom Fields:`;
          for (const [key, value] of Object.entries(teamMemberInfo.custom_fields)) {
            if (value !== null && value !== undefined) {
              contextMessage = `${contextMessage}\n${key}: ${value}`;
            }
          }
        }
      } else {
        // Si no se pudo obtener información detallada, al menos añadir el ID
        contextMessage = `${contextMessage}\nTeam Member ID: ${team_member_id}`;
      }
    }
    
    // Define default tools in case agent doesn't have any - empty array as per specification
    const defaultTools: any[] = [
      {
        "type": "function",
        "function": {
          "name": "GET_LEAD_DETAILS",
          "description": "Get details about a lead by providing name, email, company, and phone",
          "parameters": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "The name of the lead."
              },
              "mail": {
                "type": "string",
                "description": "The email address of the lead."
              },
              "company": {
                "type": "string",
                "description": "The company name associated with the lead."
              },
              "phone": {
                "type": "string",
                "description": "The phone number of the lead."
              }
            },
            "additionalProperties": false
          },
          "strict": true
        }
      },
      {
        "type": "function",
        "function": {
          "name": "GET_TASK_DETAILS",
          "description": "Get details about a task by providing the task ID and a query for the name",
          "parameters": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "The ID of the task."
              },
              "query": {
                "type": "string",
                "description": "The query to search for the task name."
              }
            },
            "required": [
              "query"
            ],
            "additionalProperties": false
          },
          "strict": true
        }
      }
    ];
    
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
        },
        {
         conversation: {
            title: "conversation title" // Will be filled by the agent
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
      ],
      // Set model instead of model_id
      model: 'gpt-4.1-mini',
      modelType: 'openai'
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
    let conversationTitle = null;
    
    // Obtener resultados si existen
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      console.log(`Resultados encontrados: ${JSON.stringify(executedCommand.results).substring(0, 200)}...`);
      
      if (executedCommand.results.length === 0) {
        console.warn("⚠️ El comando completó correctamente pero no se encontraron resultados");
      } else {
        // Mostrar info detallada de los resultados para diagnóstico
        executedCommand.results.forEach((result: any, idx: number) => {
          const type = result.type || 'sin_tipo';
          const hasMessage = result.message !== undefined;
          const hasContent = result.content !== undefined;
          console.log(`📋 Resultado ${idx}: type=${type}, hasMessage=${hasMessage}, hasContent=${hasContent}`);
        });
      }
      
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
      
      // EXTRACCIÓN DEL MENSAJE PRINCIPAL
      
      // Prioridad 1: Buscar objetos con property message directamente
      const messageObject = executedCommand.results.find((r: any) => r.message && r.message.content);
      if (messageObject) {
        assistantMessage = messageObject.message.content;
        console.log(`✅ Mensaje extraído de objeto con property message directa: ${assistantMessage.substring(0, 50)}...`);
      } 
      
      // Prioridad 2: Buscar resultados con type 'message' o 'text'
      else {
        const typeResults = executedCommand.results.filter((r: any) => 
          r.type === 'message' || r.type === 'text'
        );
        
        if (typeResults.length > 0) {
          const firstTypeResult = typeResults[0];
          
          if (typeof firstTypeResult.content === 'string') {
            assistantMessage = firstTypeResult.content;
          } 
          else if (firstTypeResult.content && firstTypeResult.content.message && firstTypeResult.content.message.content) {
            assistantMessage = firstTypeResult.content.message.content;
          } 
          else if (firstTypeResult.content && typeof firstTypeResult.content.content === 'string') {
            assistantMessage = firstTypeResult.content.content;
          }
          
          console.log(`✅ Mensaje extraído de resultado con type=${firstTypeResult.type}: ${assistantMessage.substring(0, 50)}...`);
        }
        
        // Prioridad 3: Cualquier objeto con propiedad content
        else if (assistantMessage === "No response generated") {
          const contentObject = executedCommand.results.find((r: any) => 
            r.content !== undefined && (
              typeof r.content === 'string' || 
              (typeof r.content === 'object' && (r.content.content || r.content.message))
            )
          );
          
          if (contentObject) {
            if (typeof contentObject.content === 'string') {
              assistantMessage = contentObject.content;
            } 
            else if (contentObject.content.message && contentObject.content.message.content) {
              assistantMessage = contentObject.content.message.content;
            } 
            else if (contentObject.content.content) {
              assistantMessage = typeof contentObject.content.content === 'string' 
                ? contentObject.content.content 
                : JSON.stringify(contentObject.content.content);
            }
            
            console.log(`✅ Mensaje extraído de objeto con property content: ${assistantMessage.substring(0, 50)}...`);
          }
          
          // Prioridad 4: Usar el primer resultado disponible
          else if (executedCommand.results.length > 0) {
            const firstResult = executedCommand.results[0];
            
            if (typeof firstResult === 'string') {
              assistantMessage = firstResult;
            } 
            else if (typeof firstResult === 'object') {
              // Intentar extraer cualquier contenido que parezca texto
              const extractedContent = 
                firstResult.content || 
                firstResult.message?.content || 
                firstResult.text || 
                JSON.stringify(firstResult);
                
              assistantMessage = typeof extractedContent === 'string' 
                ? extractedContent 
                : JSON.stringify(extractedContent);
            }
            
            console.log(`✅ Mensaje extraído como último recurso del primer resultado: ${assistantMessage.substring(0, 50)}...`);
          }
        }
      }
    } else {
      console.warn("⚠️ No se encontraron resultados en el comando ejecutado");
    }
    
    console.log(`💬 Mensaje final del asistente: ${assistantMessage.substring(0, 50)}...`);
    
    // Paso 1: Guardar los mensajes en la base de datos
    console.log(`🔄 Iniciando guardado de mensajes en la base de datos...`);
    console.log(`🧩 Parámetros de guardado: userId=${userId}, team_member_id=${team_member_id}`);
    
    try {
      // Importante: Pasamos team_member_id como parámetro teamMemberId para que se asigne correctamente el rol
      const savedMessagesPromise = saveMessages(
        userId, 
        message, 
        assistantMessage, 
        conversationId, 
        lead_id, 
        visitor_id, 
        conversationTitle, 
        agentId, 
        team_member_id,  // Aseguramos que se pasa correctamente el team_member_id
        effectiveDbUuid || internalCommandId  // Añadimos el command_id
      );
      
      // Esperar a que se complete el guardado con un timeout de seguridad
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout saving messages')), 10000)
      );
      
      // Utilizar Promise.race para manejar posibles tiempos de espera excesivos
      const savedMessages = await Promise.race([savedMessagesPromise, timeoutPromise]) as any;
      
      // Verificar que se guardaron correctamente los mensajes
      if (!savedMessages) {
        console.error(`❌ Error al guardar los mensajes en la base de datos`);
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
      
      console.log(`✅ Mensajes guardados exitosamente en la base de datos. Role asignado: ${savedMessages.userRole}`);
      console.log(`🏁 Preparando respuesta final después de completar todas las operaciones`);
      
      // Realizar una última verificación de los IDs de mensajes guardados
      if (!savedMessages.userMessageId || !savedMessages.assistantMessageId) {
        console.error(`⚠️ Advertencia: Algunos IDs de mensajes no están disponibles:`, 
          `user=${savedMessages.userMessageId}, assistant=${savedMessages.assistantMessageId}`);
      }
      
      // Si todo es correcto, devolvemos la respuesta exitosa después de completar todo el proceso
      console.log(`🚀 Enviando respuesta HTTP 200 con datos completos`);
      return NextResponse.json(
        { 
          success: true, 
          data: { 
            commandId: effectiveDbUuid || internalCommandId,
            status: 'completed',
            conversation_id: savedMessages.conversationId,
            conversation_title: savedMessages.conversationTitle,
            messages: {
              user: {
                content: message,
                message_id: savedMessages.userMessageId,
                role: savedMessages.userRole
              },
              assistant: {
                content: assistantMessage,
                message_id: savedMessages.assistantMessageId,
                role: 'assistant'
              }
            }
          } 
        },
        { status: 200 }
      );
    } catch (saveError) {
      console.error(`❌ Error durante el proceso de guardado:`, saveError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATABASE_OPERATION_FAILED', 
            message: 'Failed to complete all database operations' 
          } 
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Error al procesar la solicitud:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } },
      { status: 500 }
    );
  }
} 