import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para encontrar un agente de tipo Content Creator o Copywriter para un sitio
async function findContentCreatorAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for content creator agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente con rol "Content Creator & Copywriter" para el sitio: ${siteId}`);
    
    // Buscar un agente activo con el rol adecuado
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('status', 'active')
      .eq('role', 'Content Creator & Copywriter')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error al buscar agente con rol "Content Creator & Copywriter":', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente con rol "Content Creator & Copywriter" activo para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente con rol "Content Creator & Copywriter" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error al buscar agente de tipo Content Creator:', error);
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

// Función para obtener el contenido original
async function getContentById(contentId: string): Promise<any | null> {
  try {
    if (!isValidUUID(contentId)) {
      console.error(`ID de contenido no válido: ${contentId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo contenido con ID: ${contentId}`);
    
    const { data, error } = await supabaseAdmin
      .from('content')
      .select('*')
      .eq('id', contentId)
      .single();
    
    if (error) {
      console.error('Error al obtener contenido:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ No se encontró contenido con ID: ${contentId}`);
      return null;
    }
    
    console.log(`✅ Contenido recuperado: ${data.title || 'sin título'}`);
    return data;
  } catch (error) {
    console.error('Error al obtener contenido:', error);
    return null;
  }
}

// Función para actualizar el contenido con los cambios
async function updateContent(contentId: string, updatedContent: any): Promise<boolean> {
  try {
    if (!isValidUUID(contentId)) {
      console.error(`ID de contenido no válido para actualización: ${contentId}`);
      return false;
    }
    
    console.log(`✏️ Actualizando contenido con ID: ${contentId}`);
    
    const { error } = await supabaseAdmin
      .from('content')
      .update(updatedContent)
      .eq('id', contentId);
    
    if (error) {
      console.error('Error al actualizar contenido:', error);
      return false;
    }
    
    console.log(`✅ Contenido actualizado correctamente`);
    return true;
  } catch (error) {
    console.error('Error al actualizar contenido:', error);
    return false;
  }
}

// Función para obtener información del agente
async function getAgentInfo(agentId: string): Promise<{ user_id: string; site_id?: string; tools?: any[] } | null> {
  try {
    if (!isValidUUID(agentId)) {
      console.error(`ID de agente no válido: ${agentId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información del agente: ${agentId}`);
    
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
    
    // Extract tools from configuration if available
    const tools = Array.isArray(config.tools) ? config.tools : [];
    
    console.log(`✅ Información del agente recuperada: user_id=${data.user_id}, site_id=${data.site_id || 'N/A'}`);
    
    return {
      user_id: data.user_id,
      site_id: data.site_id,
      tools
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
    const { 
      contentId, 
      siteId, 
      segmentId, 
      campaignId, 
      userId, 
      agent_id, 
      quickAction, 
      styleControls,
      whatImGoodAt,
      topicsImInterestedIn,
      topicsToAvoid,
      aiPrompt
    } = body;
    
    // Log received parameters
    console.log(`📨 Parámetros recibidos para content-editor: contentId=${contentId}, siteId=${siteId}, agentId=${agent_id}`);
    
    // Validate required parameters
    if (!contentId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'contentId is required' } },
        { status: 400 }
      );
    }
    
    if (!siteId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } },
        { status: 400 }
      );
    }
    
    // Get original content
    const originalContent = await getContentById(contentId);
    if (!originalContent) {
      return NextResponse.json(
        { success: false, error: { code: 'CONTENT_NOT_FOUND', message: 'The specified content does not exist' } },
        { status: 404 }
      );
    }
    
    // Determine the user ID from the request or agent
    let effectiveUserId = userId;
    let effectiveAgentId = agent_id;
    
    // Si no se proporciona agent_id, buscar uno para el sitio
    if (!effectiveAgentId) {
      const foundAgent = await findContentCreatorAgent(siteId);
      if (foundAgent) {
        effectiveAgentId = foundAgent.agentId;
        if (!effectiveUserId) {
          effectiveUserId = foundAgent.userId;
        }
        console.log(`🤖 Usando agente con rol "Content Creator & Copywriter" encontrado: ${effectiveAgentId} (user_id: ${effectiveUserId})`);
      }
    }
    
    // Si se proporciona agent_id, obtener su user_id si no tenemos uno
    if (effectiveAgentId && !effectiveUserId) {
      const agentInfo = await getAgentInfo(effectiveAgentId);
      
      if (!agentInfo) {
        return NextResponse.json(
          { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } },
          { status: 404 }
        );
      }
      
      effectiveUserId = agentInfo.user_id;
    }
    
    // Validate we have a user ID one way or another
    if (!effectiveUserId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId or agent_id is required' } },
        { status: 400 }
      );
    }
    
    // Valores neutros predeterminados para los controles de estilo
    const defaultStyleControls = {
      tone: "neutral",
      complexity: "moderate",
      creativity: "balanced",
      persuasiveness: "balanced",
      targetAudience: "mixed",
      engagement: "balanced",
      size: "medium"
    };

    // Combinar los controles de estilo proporcionados con los predeterminados
    const effectiveStyleControls = {
      ...defaultStyleControls,
      ...(styleControls || {})
    };
    
    // Acción rápida predeterminada
    const effectiveQuickAction = quickAction || 'improve';
    
    console.log(`👤 Usuario efectivo para el comando: ${effectiveUserId}`);
    console.log(`🎨 Controles de estilo: ${JSON.stringify(effectiveStyleControls)}`);
    console.log(`🚀 Acción rápida: ${effectiveQuickAction}`);
    
    // Build context message with all relevant information
    let contextMessage = `Edit the following content based on the specified parameters:\n\n`;
    
    // Add original content information
    contextMessage += `Original Content:\nTitle: ${originalContent.title || 'No title'}\nDescription: ${originalContent.description || 'No description'}\nText: ${originalContent.text || 'No text'}\nType: ${originalContent.type || 'No type'}\n\n`;
    
    // Add quick action if specified
    contextMessage += `Quick Action: ${effectiveQuickAction}\n`;
    
    // Add style controls
    contextMessage += `Style Controls:\n`;
    for (const [key, value] of Object.entries(effectiveStyleControls)) {
      contextMessage += `${key}: ${value}\n`;
    }
    contextMessage += `\n`;
    
    // Add user prompts if specified
    if (whatImGoodAt || topicsImInterestedIn || topicsToAvoid || aiPrompt) {
      contextMessage += `User Preferences:\n`;
      if (whatImGoodAt) contextMessage += `What I'm Good At: ${whatImGoodAt}\n`;
      if (topicsImInterestedIn) contextMessage += `Topics I'm Interested In: ${topicsImInterestedIn}\n`;
      if (topicsToAvoid) contextMessage += `Topics to Avoid: ${topicsToAvoid}\n`;
      if (aiPrompt) contextMessage += `Custom Instructions: ${aiPrompt}\n`;
      contextMessage += `\n`;
    }
    
    // Add other context parameters
    if (segmentId) contextMessage += `Segment ID: ${segmentId}\n`;
    if (campaignId) contextMessage += `Campaign ID: ${campaignId}\n`;
    contextMessage += `Site ID: ${siteId}\n`;
    
    // Add instructions for output format
    contextMessage += `\nPlease format your response as a JSON object with the following structure:
{
  "title": "Edited title",
  "description": "Edited description",
  "text": "Edited content text"
}
`;

    // Añadir un objeto JSON con los valores exactos para que el agente pueda parsearlos más fácilmente
    contextMessage += `\n\nExact content values in JSON format for easier processing:
{
  "title": "${originalContent.title?.replace(/"/g, '\\"') || ''}",
  "description": "${originalContent.description?.replace(/"/g, '\\"') || ''}",
  "text": "${originalContent.text?.replace(/"/g, '\\"')?.substring(0, 1000) || ''}${originalContent.text && originalContent.text.length > 1000 ? '...' : ''}",
  "type": "${originalContent.type?.replace(/"/g, '\\"') || ''}"
}
`;
    
    // Create command for content editing
    const command = CommandFactory.createCommand({
      task: 'edit content',
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      site_id: siteId,
      description: 'Edit the content according to the specified quick action and style controls, while considering the user preferences.',
      targets: [
        {
          content: {
            title: "Improved title for the content",
            description: "Summary of the content",
            text: "Final copy with the best format for the content type, for blog entries alwyas use markdown",
          }
        }
      ],
      context: contextMessage,
      supervisor: [
        {
          agent_role: 'content_editor',
          status: 'not_initialized'
        },
        {
          agent_role: 'content_reviewer',
          status: 'not_initialized'
        }
      ],
      // Set model
      model: 'gpt-4.1',
      modelType: 'openai'
    });
    
    // Log agent information
    console.log(`🤖 Usando agente para edición de contenido: ${effectiveAgentId || 'No disponible'}`);
    
    // Submit the command for processing
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando de edición de contenido creado con ID interno: ${internalCommandId}`);
    
    // Try to get the database UUID right after creating the command
    let initialDbUuid = await getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
    }
    
    // Wait for the command to complete
    const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
    
    // Use the UUID obtained initially if we don't have a valid one after execution
    const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
    
    if (!completed || !executedCommand) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'The command did not complete successfully in the expected time' 
          },
          command_id: effectiveDbUuid || internalCommandId,
          status: executedCommand?.status || 'unknown'
        },
        { status: 500 }
      );
    }
    
    // Extract the edited content from the executed command
    let editedContent = {
      title: originalContent.title,
      description: originalContent.description,
      text: originalContent.text,
      type: originalContent.type
    };
    
    // Extract results if they exist
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      console.log(`Resultados encontrados: ${JSON.stringify(executedCommand.results).substring(0, 200)}...`);
      
      // Look for content results
      const contentResults = executedCommand.results.find((r: any) => 
        r.content && (r.content.title || r.content.description || r.content.text)
      );
      
      if (contentResults && contentResults.content) {
        // Update edited content with results
        if (contentResults.content.title) editedContent.title = contentResults.content.title;
        if (contentResults.content.description) editedContent.description = contentResults.content.description;
        if (contentResults.content.text) editedContent.text = contentResults.content.text;
        if (contentResults.content.type) editedContent.type = contentResults.content.type;
        
        console.log(`✅ Contenido editado extraído: ${editedContent.title}`);
      } else {
        // Alternative search structures
        let foundContent = false;
        
        // Estrategia 1: Buscar resultados con type: 'content'
        for (const result of executedCommand.results) {
          if (result.type === 'content' && result.content) {
            if (result.content.title) editedContent.title = result.content.title;
            if (result.content.description) editedContent.description = result.content.description;
            if (result.content.text) editedContent.text = result.content.text;
            if (result.content.type) editedContent.type = result.content.type;
            console.log(`✅ Contenido editado extraído (tipo alternativo): ${editedContent.title}`);
            foundContent = true;
            break;
          }
        }
        
        // Estrategia 2: Buscar directamente un objeto que tenga title, description o text en el primer nivel
        if (!foundContent) {
          for (const result of executedCommand.results) {
            if (result.title || result.description || result.text) {
              if (result.title) editedContent.title = result.title;
              if (result.description) editedContent.description = result.description;
              if (result.text) editedContent.text = result.text;
              if (result.type) editedContent.type = result.type;
              console.log(`✅ Contenido editado extraído (formato JSON directo): ${editedContent.title}`);
              foundContent = true;
              break;
            }
          }
        }
        
        // Estrategia 3: Buscar una respuesta JSON que podría estar en format de texto
        if (!foundContent) {
          for (const result of executedCommand.results) {
            // Comprobar si hay una propiedad que pueda contener JSON como string
            if (result.text || result.content || result.response || result.result) {
              const jsonStr = result.text || result.content || result.response || result.result;
              if (typeof jsonStr === 'string') {
                try {
                  // Intentar parsear el string como JSON
                  const parsedJson = JSON.parse(jsonStr);
                  if (parsedJson.title || parsedJson.description || parsedJson.text) {
                    if (parsedJson.title) editedContent.title = parsedJson.title;
                    if (parsedJson.description) editedContent.description = parsedJson.description;
                    if (parsedJson.text) editedContent.text = parsedJson.text;
                    console.log(`✅ Contenido editado extraído (JSON parseado): ${editedContent.title}`);
                    foundContent = true;
                    break;
                  }
                } catch (e) {
                  // Error al parsear, ignorar y continuar
                }
              }
            }
          }
        }
      }
    } else {
      console.warn("⚠️ No se encontraron resultados en el comando ejecutado");
    }
    
    // Update content in the database with command_id
    const savedToDatabase = await updateContent(contentId, {
      title: editedContent.title,
      description: editedContent.description,
      text: editedContent.text,
      // Don't update type as it's a fundamental property
      updated_at: new Date().toISOString(),
      command_id: effectiveDbUuid || internalCommandId // Añadir el command_id a la actualización
    });
    
    // Return response focused on operation status and command info
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: effectiveDbUuid || internalCommandId,
          status: executedCommand.status,
          contentId,
          siteId,
          segmentId,
          campaignId,
          original_content: {
            title: originalContent.title,
            description: originalContent.description,
            text: originalContent.text,
            type: originalContent.type
          },
          edited_content: editedContent,
          applied_actions: {
            quick_action: effectiveQuickAction,
            style_controls: effectiveStyleControls
          },
          saved_to_database: savedToDatabase
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