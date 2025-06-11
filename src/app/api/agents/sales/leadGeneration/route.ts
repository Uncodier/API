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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extract parameters from the request
    const { 
      siteId, 
      userId, 
      agent_id,
      leadGenData,
      maxLeads = 10,
      priority = "medium",
      webhook
    } = body;
    
    // Validate required parameters
    if (!siteId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } },
        { status: 400 }
      );
    }
    
    if (!leadGenData) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'leadGenData is required' } },
        { status: 400 }
      );
    }
    
    if (!leadGenData.targetAudience) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'leadGenData.targetAudience is required' } },
        { status: 400 }
      );
    }
    
    // Get agent info if agent_id is provided
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
      
      // Use agent's user_id if none was provided
      if (!effectiveUserId) {
        effectiveUserId = agentInfo.user_id;
      }
    }
    
    // Error if we still don't have a userId
    if (!effectiveUserId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required if agent_id is not provided' } },
        { status: 400 }
      );
    }
    
    // Prepare context message for the command
    let contextMessage = "";
    const { targetAudience, searchCriteria, productOffering, businessInfo } = leadGenData;
    
    // Add target audience information to context
    if (targetAudience) {
      contextMessage += "Target Audience:\n";
      
      if (targetAudience.industries && Array.isArray(targetAudience.industries)) {
        contextMessage += `Industries: ${targetAudience.industries.join(', ')}\n`;
      }
      
      if (targetAudience.companySize && Array.isArray(targetAudience.companySize)) {
        contextMessage += `Company Size: ${targetAudience.companySize.join(', ')}\n`;
      }
      
      if (targetAudience.roles && Array.isArray(targetAudience.roles)) {
        contextMessage += `Roles: ${targetAudience.roles.join(', ')}\n`;
      }
      
      if (targetAudience.locations && Array.isArray(targetAudience.locations)) {
        contextMessage += `Locations: ${targetAudience.locations.join(', ')}\n`;
      }
      
      if (targetAudience.interests && Array.isArray(targetAudience.interests)) {
        contextMessage += `Interests: ${targetAudience.interests.join(', ')}\n`;
      }
    }
    
    // Add search criteria to context
    if (searchCriteria) {
      contextMessage += "\nSearch Criteria:\n";
      
      if (searchCriteria.keywords && Array.isArray(searchCriteria.keywords)) {
        contextMessage += `Keywords: ${searchCriteria.keywords.join(', ')}\n`;
      }
      
      if (searchCriteria.excludedTerms && Array.isArray(searchCriteria.excludedTerms)) {
        contextMessage += `Excluded Terms: ${searchCriteria.excludedTerms.join(', ')}\n`;
      }
      
      if (searchCriteria.minRevenueUSD) {
        contextMessage += `Min Revenue (USD): ${searchCriteria.minRevenueUSD}\n`;
      }
      
      if (searchCriteria.maxRevenueUSD) {
        contextMessage += `Max Revenue (USD): ${searchCriteria.maxRevenueUSD}\n`;
      }
      
      if (searchCriteria.hasWebsite !== undefined) {
        contextMessage += `Has Website: ${searchCriteria.hasWebsite ? 'Yes' : 'No'}\n`;
      }
    }
    
    // Add product offering to context
    if (productOffering) {
      contextMessage += "\nProduct Offering:\n";
      
      if (productOffering.name) {
        contextMessage += `Name: ${productOffering.name}\n`;
      }
      
      if (productOffering.primaryValue) {
        contextMessage += `Primary Value: ${productOffering.primaryValue}\n`;
      }
      
      if (productOffering.idealCustomerProfile) {
        contextMessage += `Ideal Customer Profile: ${productOffering.idealCustomerProfile}\n`;
      }
    }
    
    // Add business information to context
    if (businessInfo) {
      contextMessage += "\nBusiness Information:\n";
      
      if (businessInfo.name) {
        contextMessage += `Name: ${businessInfo.name}\n`;
      }
      
      if (businessInfo.industry) {
        contextMessage += `Industry: ${businessInfo.industry}\n`;
      }
      
      if (businessInfo.uniqueSellingPoints && Array.isArray(businessInfo.uniqueSellingPoints)) {
        contextMessage += `Unique Selling Points:\n`;
        businessInfo.uniqueSellingPoints.forEach((point: string, index: number) => {
          contextMessage += `- ${point}\n`;
        });
      }
    }
    
    // Add maxLeads, priority and webhook info to context
    contextMessage += `\nRequest Configuration:\n`;
    contextMessage += `Max Leads: ${maxLeads}\n`;
    contextMessage += `Priority: ${priority}\n`;
    
    if (webhook) {
      contextMessage += `Webhook URL: ${webhook.url}\n`;
      if (webhook.metadata) {
        contextMessage += `Webhook Metadata: ${JSON.stringify(webhook.metadata)}\n`;
      }
    }
    
    // Prepare target audience data for the command
    const targetAudienceData = {
      industries: targetAudience.industries || [],
      company_sizes: targetAudience.companySize || [],
      roles: targetAudience.roles || [],
      locations: targetAudience.locations || [],
      interests: targetAudience.interests || []
    };
    
    // Prepare search parameters
    const searchParameters = searchCriteria ? {
      keywords: searchCriteria.keywords || [],
      excluded_terms: searchCriteria.excludedTerms || [],
      revenue_range: {
        min: searchCriteria.minRevenueUSD || 0,
        max: searchCriteria.maxRevenueUSD || 0
      },
      has_website: searchCriteria.hasWebsite !== undefined ? searchCriteria.hasWebsite : true
    } : undefined;
    
    // Default tools for lead generation
    const defaultTools = [
      {
        type: "function",
        function: {
          name: "RESEARCH_COMPANIES",
          description: "Research companies that match the target audience criteria",
          parameters: {
            type: "object",
            properties: {
              industry: {
                type: "string",
                description: "Industry to research"
              },
              location: {
                type: "string",
                description: "Geographic location"
              },
              company_size: {
                type: "string",
                description: "Size of company (e.g., '10-50', '51-200')"
              },
              keywords: {
                type: "array",
                items: {
                  type: "string"
                },
                description: "Keywords related to the company"
              }
            },
            required: ["industry"],
            additionalProperties: false
          },
          strict: true
        }
      },
      {
        type: "function",
        function: {
          name: "FIND_CONTACT_PERSON",
          description: "Find contact person at a specific company based on role",
          parameters: {
            type: "object",
            properties: {
              company: {
                type: "string",
                description: "Name of the company"
              },
              role: {
                type: "string",
                description: "Role or position to look for"
              }
            },
            required: ["company", "role"],
            additionalProperties: false
          },
          strict: true
        }
      },
      {
        type: "function",
        function: {
          name: "VERIFY_LEAD",
          description: "Verify if a lead matches the target audience criteria",
          parameters: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Name of the lead"
              },
              company: {
                type: "string",
                description: "Company of the lead"
              },
              position: {
                type: "string",
                description: "Position or role of the lead"
              },
              email: {
                type: "string",
                description: "Email of the lead"
              }
            },
            required: ["name", "company", "position"],
            additionalProperties: false
          },
          strict: true
        }
      }
    ];
    
    // Use agent's tools if available, otherwise use default tools
    const tools = (agentInfo && agentInfo.tools && Array.isArray(agentInfo.tools) && agentInfo.tools.length > 0) 
      ? agentInfo.tools 
      : defaultTools;
    
    // Create the command using CommandFactory
    const command = CommandFactory.createCommand({
      task: "generate qualified sales leads",
      userId: effectiveUserId,
      agentId: agent_id,
      site_id: siteId,
      description: `Generate ${maxLeads} qualified leads for ${businessInfo?.name || 'the business'}, targeting ${targetAudience.roles ? targetAudience.roles.join(', ') : 'decision makers'} in ${targetAudience.industries ? targetAudience.industries.join(', ') : 'relevant industries'}.`,
      targets: [
        {
          leads: {
            count: maxLeads,
            profile: targetAudienceData,
            search_parameters: searchParameters
          }
        }
      ],
      tools,
      context: contextMessage,
      supervisor: [
        {
          agent_role: "lead_quality_analyst",
          status: "not_initialized"
        },
        {
          agent_role: "market_researcher",
          status: "not_initialized"
        }
      ],
      // Set model
      model: "gpt-4.1",
      modelType: "openai",
      // Add webhook information to metadata
      metadata: webhook ? { 
        webhook_url: webhook.url,
        webhook_secret: webhook.secret,
        webhook_metadata: webhook.metadata
      } : undefined
    } as any); // Cast to any to avoid TypeScript error with metadata property
    
    // Submit the command for processing
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Lead generation command created with internal ID: ${internalCommandId}`);
    
    // Try to get the database UUID immediately after creating the command
    let initialDbUuid = await getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 Database UUID obtained initially: ${initialDbUuid}`);
    }
    
    // Don't wait for command completion, just return immediately with command id
    // This makes the API asynchronous
    
    // Store the command in the database
    const now = new Date().toISOString();
    const commandRecord = {
      id: initialDbUuid || uuidv4(),
      internal_id: internalCommandId,
      site_id: siteId,
      user_id: effectiveUserId,
      agent_id: agent_id,
      task: "lead_generation",
      status: "processing",
      target_count: maxLeads,
      priority: priority,
      webhook_url: webhook?.url,
      created_at: now,
      updated_at: now,
      metadata: {
        targetAudience: targetAudienceData,
        searchCriteria: searchParameters,
        businessInfo: businessInfo || null,
        productOffering: productOffering || null
      }
    };
    
    // Only insert if we don't have an initialDbUuid
    if (!initialDbUuid) {
      try {
        const { data, error } = await supabaseAdmin
          .from('commands')
          .insert([commandRecord])
          .select('id')
          .single();
        
        if (error) {
          console.error('Error storing command in database:', error);
        } else if (data) {
          initialDbUuid = data.id;
          console.log(`📝 Command stored in database with ID: ${initialDbUuid}`);
        }
      } catch (dbError) {
        console.error('Error storing command in database:', dbError);
      }
    }
    
    // Return success response with command ID and estimated completion time
    const estimatedCompletionTime = new Date();
    estimatedCompletionTime.setMinutes(estimatedCompletionTime.getMinutes() + 10); // Estimate 10 minutes
    
    return NextResponse.json({
      success: true,
      data: {
        command_id: initialDbUuid || internalCommandId,
        site_id: siteId,
        status: "processing",
        estimated_completion_time: estimatedCompletionTime.toISOString(),
        leads_requested: maxLeads,
        job_priority: priority,
        process_info: {
          stage: "initial_search",
          progress_percentage: 5
        }
      }
    });
    
  } catch (error) {
    console.error('General error in lead generation route:', error);
    
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