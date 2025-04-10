import { NextResponse } from 'next/server';
import { CommandFactory, AgentInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Inicializar el agente y obtener el servicio de comandos
const agentInitializer = AgentInitializer.getInstance();
agentInitializer.initialize();
const commandService = agentInitializer.getCommandService();

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
async function saveMessages(userId: string, userMessage: string, assistantMessage: string, conversationId?: string) {
  try {
    // Verificar si tenemos un ID de conversación
    if (!conversationId) {
      // Crear una nueva conversación si no existe
      const { data: conversation, error: convError } = await supabaseAdmin
        .from('conversations')
        .insert([{ user_id: userId }])
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
    const { data: userMessageData, error: userMsgError } = await supabaseAdmin
      .from('messages')
      .insert([{
        conversation_id: conversationId,
        user_id: userId,
        content: userMessage,
        role: 'user'
      }])
      .select()
      .single();
    
    if (userMsgError) {
      console.error('Error al guardar mensaje del usuario:', userMsgError);
      return null;
    }
    
    console.log(`💾 Mensaje del usuario guardado con ID: ${userMessageData.id}`);
    
    // Guardar el mensaje del asistente
    const { data: assistantMessageData, error: assistantMsgError } = await supabaseAdmin
      .from('messages')
      .insert([{
        conversation_id: conversationId,
        content: assistantMessage,
        role: 'assistant'
      }])
      .select()
      .single();
    
    if (assistantMsgError) {
      console.error('Error al guardar mensaje del asistente:', assistantMsgError);
      return null;
    }
    
    console.log(`💾 Mensaje del asistente guardado con ID: ${assistantMessageData.id}`);
    
    return {
      conversationId,
      userMessageId: userMessageData.id,
      assistantMessageId: assistantMessageData.id
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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extract required parameters from the request
    const { conversationId, userId, message, agentId } = body;
    
    if (!userId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required' } },
        { status: 400 }
      );
    }
    
    // Asegurarse de que userId sea un UUID válido
    if (!isValidUUID(userId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    if (!message) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'message is required' } },
        { status: 400 }
      );
    }
    
    // Get default agent ID if not provided
    const effectiveAgentId = agentId || 'default_customer_support_agent';
    
    console.log(`Creando comando para agente: ${effectiveAgentId}, usuario: ${userId}`);
    
    // Retrieve conversation history if a conversation ID is provided
    let contextMessage = `Current message: ${message}`;
    
    if (conversationId && isValidUUID(conversationId)) {
      console.log(`🔄 Recuperando historial para la conversación: ${conversationId}`);
      const historyMessages = await getConversationHistory(conversationId);
      
      if (historyMessages && historyMessages.length > 0) {
        // Filter out any messages that might be duplicates of the current message
        // This prevents the current message from appearing twice in the context
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
    
    // Create the command using CommandFactory with the conversation history in the context
    const command = CommandFactory.createCommand({
      task: 'create message',
      userId,
      agentId: effectiveAgentId,
      description: 'Respond helpfully to the customer, assist with order status inquiries, and provide solutions for any issues with their recent purchase.',
      // Set the target as a message with content
      targets: [
        {
          message: {
            content: "message example" // Will be filled by the agent
          }
        }
      ],
      // Define the tools as specified in the documentation
      tools: [
        CommandFactory.createTool({
          name: 'escalate',
          description: 'escalate when needed',
          type: 'synchronous',
          parameters: {
            conversation: 'required',
            lead_id: 'required'
          }
        }),
        CommandFactory.createTool({
          name: 'contact_human',
          description: 'contact human supervisor when complex issues require human intervention',
          type: 'asynchronous',
          parameters: {
            conversation: 'required',
            lead_id: 'required'
          }
        })
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
      
      // Guardar los mensajes en la base de datos
      const savedMessages = await saveMessages(userId, message, assistantMessage, conversationId);
      
      // Responder usando el ID interno como respaldo
      return NextResponse.json(
        { 
          success: true, 
          data: { 
            command_id: internalCommandId, // Usamos el ID interno como respaldo
            conversation_id: savedMessages?.conversationId,
            messages: {
              user: {
                content: message,
                message_id: savedMessages?.userMessageId
              },
              assistant: {
                content: assistantMessage,
                message_id: savedMessages?.assistantMessageId
              }
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
    
    // Guardar los mensajes en la base de datos
    const savedMessages = await saveMessages(userId, message, assistantMessage, conversationId);
    
    // Preparar la respuesta con todos los IDs importantes
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          // Usar el UUID de la base de datos como ID principal del comando
          command_id: effectiveDbUuid,
          internal_command_id: internalCommandId, // El ID con prefijo cmd_ como referencia interna
          conversation_id: savedMessages?.conversationId, // ID de la conversación
          messages: {
            user: {
              content: message,
              message_id: savedMessages?.userMessageId
            },
            assistant: {
              content: assistantMessage,
              message_id: savedMessages?.assistantMessageId
            }
          }
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error al procesar la solicitud:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred' } },
      { status: 500 }
    );
  }
}