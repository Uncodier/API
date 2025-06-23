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
        
        // Considerar comandos en estado 'failed' como completados si tienen resultados
        const hasResults = executedCommand.results && executedCommand.results.length > 0;
        const commandFinished = executedCommand.status === 'completed' || 
                               (executedCommand.status === 'failed' && hasResults);
                               
        if (commandFinished) {
          console.log(`✅ Comando ${commandId} terminado con estado: ${executedCommand.status}${hasResults ? ' (con resultados)' : ''}`);
          
          // Intentar obtener el UUID de la base de datos si aún no lo tenemos
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido después de completar: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          // Consideramos un comando fallido como "completado" si tiene resultados
          const effectivelyCompleted = executedCommand.status === 'completed' || 
                                     (executedCommand.status === 'failed' && hasResults);
          resolve({command: executedCommand, dbUuid, completed: effectivelyCompleted});
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
          // Verificar si, a pesar del timeout, hay resultados utilizables
          const usableResults = executedCommand.results && executedCommand.results.length > 0;
          resolve({command: executedCommand, dbUuid, completed: usableResults});
        }
      } catch (error) {
        console.error(`Error al verificar estado del comando ${commandId}:`, error);
        clearInterval(checkInterval);
        resolve({command: null, dbUuid: null, completed: false});
      }
    }, delayMs);
  });
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
    
    return {
      user_id: data.user_id,
      site_id: data.site_id,
      tools: config.tools || [],
      activities: config.activities || []
    };
  } catch (error) {
    console.error('Error al obtener información del agente:', error);
    return null;
  }
}

// Función para obtener la información del lead desde la base de datos
async function getLeadInfo(leadId: string): Promise<any | null> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`ID de lead no válido: ${leadId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información del lead: ${leadId}`);
    
    // Consultar el lead en la base de datos
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single();
    
    if (error) {
      console.error('Error al obtener información del lead:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ No se encontró el lead con ID: ${leadId}`);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error al obtener información del lead:', error);
    return null;
  }
}

// Función para obtener las interacciones previas con un lead
async function getPreviousInteractions(leadId: string, limit = 10): Promise<any[]> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`ID de lead no válido: ${leadId}`);
      return [];
    }
    
    console.log(`🔍 Obteniendo interacciones previas con el lead: ${leadId}`);
    
    // Consultar las interacciones previas
    const { data, error } = await supabaseAdmin
      .from('lead_interactions')
      .select('*')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) {
      console.error('Error al obtener interacciones previas:', error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontraron interacciones previas para el lead: ${leadId}`);
      return [];
    }
    
    return data;
  } catch (error) {
    console.error('Error al obtener interacciones previas:', error);
    return [];
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extraer parámetros de la solicitud
    const { 
      siteId, 
      leadId, 
      userId, 
      agent_id,
      followUpType,
      leadStage,
      previousInteractions,
      leadData,
      productInterest,
      followUpInterval
    } = body;
    
    // Validar parámetros requeridos
    if (!siteId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } },
        { status: 400 }
      );
    }
    
    if (!leadId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'leadId is required' } },
        { status: 400 }
      );
    }
    
    // Obtener información del agente si se proporciona agent_id
    let agentInfo: any = null;
    let effectiveUserId = userId;
    
    if (agent_id) {
      agentInfo = await getAgentInfo(agent_id);
      
      if (!agentInfo) {
        return NextResponse.json(
          { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } },
          { status: 404 }
        );
      }
      
      // Si no se proporcionó un userId, usar el del agente
      if (!effectiveUserId) {
        effectiveUserId = agentInfo.user_id;
      }
    }
    
    // Si aún no tenemos un userId, error
    if (!effectiveUserId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required if agent_id is not provided' } },
        { status: 400 }
      );
    }
    
    // Obtener información del lead desde la base de datos si no se proporcionó
    let effectiveLeadData = leadData;
    if (!effectiveLeadData || Object.keys(effectiveLeadData).length === 0) {
      const leadInfo = await getLeadInfo(leadId);
      if (leadInfo) {
        effectiveLeadData = leadInfo;
      }
    }
    
    // Obtener interacciones previas si no se proporcionaron
    let effectivePreviousInteractions = previousInteractions;
    if (!effectivePreviousInteractions || !Array.isArray(effectivePreviousInteractions) || effectivePreviousInteractions.length === 0) {
      const interactions = await getPreviousInteractions(leadId);
      if (interactions && interactions.length > 0) {
        effectivePreviousInteractions = interactions;
      }
    }
    
    // Preparar el contexto para el comando
    let contextMessage = `Lead ID: ${leadId}\nSite ID: ${siteId}`;
    
    // Añadir información del lead al contexto
    if (effectiveLeadData) {
      contextMessage += `\n\nLead Information:`;
      
      if (effectiveLeadData.name) contextMessage += `\nName: ${effectiveLeadData.name}`;
      if (effectiveLeadData.company) contextMessage += `\nCompany: ${effectiveLeadData.company}`;
      if (effectiveLeadData.position) contextMessage += `\nPosition: ${effectiveLeadData.position}`;
      if (effectiveLeadData.email) contextMessage += `\nEmail: ${effectiveLeadData.email}`;
      if (effectiveLeadData.phone) contextMessage += `\nPhone: ${effectiveLeadData.phone}`;
      
      // Si hay campos personalizados o información adicional
      if (effectiveLeadData.pain_points) {
        if (Array.isArray(effectiveLeadData.pain_points)) {
          contextMessage += `\nPain Points: ${effectiveLeadData.pain_points.join(', ')}`;
        } else {
          contextMessage += `\nPain Points: ${effectiveLeadData.pain_points}`;
        }
      }
      
      if (effectiveLeadData.budget_range) {
        contextMessage += `\nBudget Range: ${effectiveLeadData.budget_range}`;
      }
    }
    
    // Añadir información de interacciones previas al contexto
    if (effectivePreviousInteractions && effectivePreviousInteractions.length > 0) {
      contextMessage += `\n\nPrevious Interactions:`;
      
      effectivePreviousInteractions.forEach((interaction: any, index: number) => {
        contextMessage += `\n${index + 1}. Date: ${interaction.date || interaction.created_at}`;
        contextMessage += `\n   Type: ${interaction.type || 'Unknown'}`;
        contextMessage += `\n   Summary: ${interaction.summary || interaction.content || 'No summary available'}`;
        
        if (index < effectivePreviousInteractions.length - 1) {
          contextMessage += `\n`;
        }
      });
    }
    
    // Añadir información de productos de interés
    if (productInterest && Array.isArray(productInterest) && productInterest.length > 0) {
      contextMessage += `\n\nProducts of Interest: ${productInterest.join(', ')}`;
    }
    
    // Añadir información de la etapa del lead
    if (leadStage) {
      contextMessage += `\n\nLead Stage: ${leadStage}`;
    }
    
    // Añadir tipo de seguimiento solicitado
    if (followUpType) {
      contextMessage += `\n\nRequested Follow-up Type: ${followUpType}`;
    }
    
    // Añadir intervalo de seguimiento solicitado
    if (followUpInterval) {
      contextMessage += `\n\nRequested Follow-up Interval: ${followUpInterval}`;
    }
    
    // Definir herramientas predeterminadas para el agente de seguimiento de leads
    const defaultTools: any[] = [
      {
        "type": "function",
        "function": {
          "name": "GET_LEAD_DETAILS",
          "description": "Get details about a lead by providing name, email, company, or phone",
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
          "name": "SCHEDULE_FOLLOW_UP",
          "description": "Schedule a follow-up action for a lead",
          "parameters": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "description": "The type of follow-up (e.g., email, call, meeting)."
              },
              "subject": {
                "type": "string",
                "description": "The subject or title of the follow-up."
              },
              "content": {
                "type": "string",
                "description": "The content or script for the follow-up."
              },
              "scheduled_for": {
                "type": "string",
                "description": "The date and time for the follow-up in ISO format."
              },
              "next_steps": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "List of potential next steps after this follow-up."
              }
            },
            "required": [
              "type",
              "scheduled_for"
            ],
            "additionalProperties": false
          },
          "strict": true
        }
      },
      {
        "type": "function",
        "function": {
          "name": "UPDATE_LEAD_STATUS",
          "description": "Update the status of a lead in the CRM",
          "parameters": {
            "type": "object",
            "properties": {
              "status": {
                "type": "string",
                "description": "The new status of the lead (e.g., new, contacted, qualified, opportunity)."
              },
              "notes": {
                "type": "string",
                "description": "Additional notes about the status update."
              }
            },
            "required": [
              "status"
            ],
            "additionalProperties": false
          },
          "strict": true
        }
      }
    ];
    
    // Usar las herramientas del agente si están disponibles, de lo contrario usar las predeterminadas
    const tools = (agentInfo && agentInfo.tools && Array.isArray(agentInfo.tools) && agentInfo.tools.length > 0) 
      ? agentInfo.tools 
      : defaultTools;
    
    // Crear el comando usando CommandFactory
    const command = CommandFactory.createCommand({
      task: 'create lead follow-up sequence',
      userId: effectiveUserId,
      agentId: agent_id,
      // Agregar site_id como propiedad básica
      site_id: siteId,
      description: 'Generate a personalized follow-up sequence for a qualified lead, focusing on addressing their pain points and interests, with appropriate timing between touchpoints.',
      // Establecer el target como un objeto de seguimiento
      targets: [
        {
          follow_ups: []  // Se llenará por el agente
        }
      ],
      // Usar herramientas del agente o herramientas predeterminadas
      tools,
      // Contexto incluye la información del lead y las interacciones previas
      context: contextMessage,
      // Agregar supervisores
      supervisor: [
        {
          agent_role: 'sales_manager',
          status: 'not_initialized'
        },
        {
          agent_role: 'customer_success',
          status: 'not_initialized'
        }
      ],
      // Establecer modelo
      model: 'gpt-4.1',
      modelType: 'openai'
    });
    
    // Enviar el comando para procesamiento
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando de seguimiento de lead creado con ID interno: ${internalCommandId}`);
    
    // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
    let initialDbUuid = await getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
    }
    
    // Esperar a que el comando se complete
    const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
    
    // Usar el UUID obtenido inicialmente si no tenemos uno válido después de la ejecución
    const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
    
    // Si no completado y no hay resultados, retornar error
    if (!completed) {
      console.warn(`⚠️ Comando ${internalCommandId} no completó exitosamente en el tiempo esperado`);
      
      if (!executedCommand || !executedCommand.results || executedCommand.results.length === 0) {
        // Solo fallar si realmente no hay resultados utilizables
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'COMMAND_EXECUTION_FAILED', 
              message: 'El comando no completó exitosamente y no se generaron resultados válidos' 
            } 
          },
          { status: 500 }
        );
      } else {
        // Si hay resultados a pesar del estado, continuamos con advertencia
        console.log(`⚠️ Comando en estado ${executedCommand.status} pero tiene ${executedCommand.results.length} resultados, continuando`);
      }
    }
    
    // Extraer los seguimientos generados de los resultados
    let followUps: any[] = [];
    
    if (executedCommand.results && Array.isArray(executedCommand.results) && executedCommand.results.length > 0) {
      // Buscar resultados que contengan follow_ups
      const followUpResults = executedCommand.results.find((r: any) => 
        r.follow_ups || (r.content && r.content.follow_ups)
      );
      
      if (followUpResults) {
        if (Array.isArray(followUpResults.follow_ups)) {
          followUps = followUpResults.follow_ups;
        } else if (followUpResults.content && Array.isArray(followUpResults.content.follow_ups)) {
          followUps = followUpResults.content.follow_ups;
        }
      }
      
      // Si aún no tenemos follow ups, buscar en el primer resultado como último recurso
      if (followUps.length === 0 && executedCommand.results.length > 0) {
        const firstResult = executedCommand.results[0];
        
        if (firstResult && typeof firstResult === 'object') {
          if (Array.isArray(firstResult)) {
            followUps = firstResult;
          } else if (firstResult.content) {
            if (Array.isArray(firstResult.content)) {
              followUps = firstResult.content;
            } else if (firstResult.content.content && Array.isArray(firstResult.content.content)) {
              followUps = firstResult.content.content;
            }
          }
        }
      }
    }
    
    // Guardar los follow-ups en la base de datos
    const savedFollowUps: any[] = [];
    
    for (const followUp of followUps) {
      try {
        const followUpData = {
          site_id: siteId,
          lead_id: leadId,
          user_id: effectiveUserId,
          agent_id: agent_id,
          type: followUp.type,
          subject: followUp.subject,
          content: followUp.content,
          scheduled_for: followUp.scheduled_for,
          next_steps: Array.isArray(followUp.next_steps) ? followUp.next_steps : null,
          status: 'scheduled',
          command_id: effectiveDbUuid || internalCommandId
        };
        
        const { data, error } = await supabaseAdmin
          .from('lead_follow_ups')
          .insert([followUpData])
          .select()
          .single();
        
        if (error) {
          console.error('Error al guardar follow-up:', error);
        } else if (data) {
          savedFollowUps.push(data);
        }
      } catch (saveError) {
        console.error('Error al guardar follow-up:', saveError);
      }
    }
    
    // Preparar la respuesta
    return NextResponse.json({
      success: true,
      data: {
        command_id: effectiveDbUuid || internalCommandId,
        siteId,
        leadId,
        follow_ups: savedFollowUps.length > 0 ? savedFollowUps : followUps,
        saved_to_database: savedFollowUps.length > 0
      }
    });
    
  } catch (error) {
    console.error('Error general en la ruta de follow-up de leads:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: 'An internal system error occurred' 
        } 
      },
      { status: 500 }
    );
  }
} 