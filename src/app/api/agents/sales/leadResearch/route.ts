import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { 
  getLeadInfo, 
  getPreviousInteractions, 
  buildEnrichedContext,
  safeStringify
} from '@/lib/helpers/lead-context-helper';

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
    
    // Consultar el agente en la base de datos
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
    
    // Extraer parámetros de la solicitud
    const { 
      site_id, 
      lead_id, 
      userId, 
      agent_id,
      researchDepth = "standard",
      researchAreas,
      includeSocialMedia = false,
      includeCompetitorAnalysis = false,
      includeFinancialInfo = false
    } = body;
    
    // Validar parámetros requeridos
    if (!site_id) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required' } },
        { status: 400 }
      );
    }
    
    if (!lead_id) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'lead_id is required' } },
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
    
    // Obtener información del lead desde la base de datos
    const leadInfo = await getLeadInfo(lead_id);
    if (!leadInfo) {
      return NextResponse.json(
        { success: false, error: { code: 'LEAD_NOT_FOUND', message: 'The specified lead was not found' } },
        { status: 404 }
      );
    }
    
    // Obtener interacciones previas
    const previousInteractions = await getPreviousInteractions(lead_id);
    
    // Preparar el contexto para el comando
    let contextMessage = `Lead Research Request\nLead ID: ${lead_id}\nSite ID: ${site_id}\n`;
    
    // Añadir información del lead al contexto
    contextMessage += `\nLead Information:`;
    if (leadInfo.name) contextMessage += `\nName: ${leadInfo.name}`;
    if (leadInfo.company) contextMessage += `\nCompany: ${safeStringify(leadInfo.company)}`;
    if (leadInfo.position) contextMessage += `\nPosition: ${leadInfo.position}`;
    if (leadInfo.email) contextMessage += `\nEmail: ${leadInfo.email}`;
    if (leadInfo.phone) contextMessage += `\nPhone: ${leadInfo.phone}`;
    if (leadInfo.location) contextMessage += `\nLocation: ${leadInfo.location}`;
    
    // Si hay campos personalizados o información adicional
    if (leadInfo.pain_points) {
      if (Array.isArray(leadInfo.pain_points)) {
        contextMessage += `\nPain Points: ${leadInfo.pain_points.join(', ')}`;
      } else {
        contextMessage += `\nPain Points: ${leadInfo.pain_points}`;
      }
    }
    
    if (leadInfo.budget_range) {
      contextMessage += `\nBudget Range: ${leadInfo.budget_range}`;
    }
    
    // Añadir información del sitio si está disponible
    if (leadInfo.sites) {
      contextMessage += `\nSite: ${leadInfo.sites.name} (${leadInfo.sites.url})`;
    }
    
    // Añadir información del visitor si está disponible
    if (leadInfo.visitors) {
      if (leadInfo.visitors.user_agent) {
        contextMessage += `\nUser Agent: ${leadInfo.visitors.user_agent}`;
      }
      // Nota: La información de location ahora se guarda solo en visitor_sessions
      // contextMessage += `\nLocation: ${leadInfo.visitors.location}`;
    }
    
    // Añadir información de interacciones previas al contexto
    if (previousInteractions && previousInteractions.length > 0) {
      contextMessage += `\n\nPrevious Interactions:`;
      
      previousInteractions.forEach((interaction: any, index: number) => {
        contextMessage += `\n${index + 1}. Date: ${interaction.date || interaction.created_at}`;
        contextMessage += `\n   Type: ${interaction.type || 'Unknown'}`;
        contextMessage += `\n   Summary: ${interaction.summary || interaction.content || 'No summary available'}`;
        
        if (index < previousInteractions.length - 1) {
          contextMessage += `\n`;
        }
      });
    }
    
    // Añadir configuración de investigación
    contextMessage += `\n\nResearch Configuration:`;
    contextMessage += `\nDepth: ${researchDepth}`;
    contextMessage += `\nInclude Social Media: ${includeSocialMedia ? 'Yes' : 'No'}`;
    contextMessage += `\nInclude Competitor Analysis: ${includeCompetitorAnalysis ? 'Yes' : 'No'}`;
    contextMessage += `\nInclude Financial Information: ${includeFinancialInfo ? 'Yes' : 'No'}`;
    
    // Añadir áreas específicas de investigación si se proporcionaron
    if (researchAreas && Array.isArray(researchAreas) && researchAreas.length > 0) {
      contextMessage += `\nSpecific Research Areas: ${researchAreas.join(', ')}`;
    }
    
    // Añadir contexto enriquecido con contenidos, tareas y conversaciones
    console.log(`🔍 Construyendo contexto enriquecido para el comando...`);
    const enrichedContext = await buildEnrichedContext(site_id, lead_id);
    if (enrichedContext) {
      contextMessage += `\n\n${enrichedContext}`;
      console.log(`✅ Contexto enriquecido añadido (${enrichedContext.length} caracteres)`);
    } else {
      console.log(`⚠️ No se pudo obtener contexto enriquecido`);
    }
    
    // Crear el comando usando CommandFactory
    const command = CommandFactory.createCommand({
      task: 'conduct comprehensive lead research',
      userId: effectiveUserId,
      agentId: agent_id,
      site_id: site_id,
      description: 'Conduct comprehensive research on a lead to gather valuable insights for sales and marketing strategies. Include company background, key personnel, recent news, competitive landscape, and potential pain points.',
      targets: [
        {
          title: "Company Background Research",
          message: "Detailed research on the lead's company including industry, size, revenue, business model, and key services/products",
          channel: "research"
        },
        {
          title: "Key Personnel Analysis",
          message: "Information about key decision makers, their roles, background, and recent activities",
          channel: "research"
        },
        {
          title: "Recent Company News & Updates",
          message: "Latest news, press releases, funding rounds, partnerships, or significant company changes",
          channel: "research"
        },
        {
          title: "Pain Points & Challenges Identification",
          message: "Analysis of potential challenges, pain points, and business needs based on available information",
          channel: "research"
        },
        {
          title: "Competitive Landscape Analysis",
          message: "Information about the company's competitors, market position, and differentiation factors",
          channel: "research"
        },
        {
          title: "Engagement Recommendations",
          message: "Strategic recommendations for how to approach and engage with this lead based on research findings",
          channel: "recommendations"
        }
      ],
      context: contextMessage,
      supervisor: [
        {
          agent_role: 'sales_manager',
          status: 'not_initialized'
        },
        {
          agent_role: 'research_analyst',
          status: 'not_initialized'
        }
      ],
      model: 'gpt-5.4',
      modelType: 'openai'
    });
    
    // Enviar el comando para procesamiento
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando de investigación de lead creado con ID interno: ${internalCommandId}`);
    
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
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'RESEARCH_EXECUTION_FAILED', 
              message: 'El comando de investigación no completó exitosamente y no se generaron resultados válidos' 
            } 
          },
          { status: 500 }
        );
      } else {
        console.log(`⚠️ Comando en estado ${executedCommand.status} pero tiene ${executedCommand.results.length} resultados, continuando`);
      }
    }
    
    // Extraer los resultados de investigación
    let researchResults: any[] = [];
    
    if (executedCommand.results && Array.isArray(executedCommand.results) && executedCommand.results.length > 0) {
      // Buscar resultados que contengan la estructura de investigación
      executedCommand.results.forEach((result: any) => {
        if (result.title && result.message && result.channel) {
          researchResults.push({
            title: result.title,
            content: result.message,
            category: result.channel,
            type: 'research_finding',
            generated_at: new Date().toISOString()
          });
        } else if (result.content && result.content.title && result.content.message && result.content.channel) {
          researchResults.push({
            title: result.content.title,
            content: result.content.message,
            category: result.content.channel,
            type: 'research_finding',
            generated_at: new Date().toISOString()
          });
        }
      });
    }
    
    // Guardar los resultados de investigación en la base de datos
    const savedResearch: any[] = [];
    
    for (const researchResult of researchResults) {
      try {
        const researchData = {
          site_id: site_id,
          lead_id: lead_id,
          user_id: effectiveUserId,
          agent_id: agent_id,
          title: researchResult.title,
          content: researchResult.content,
          category: researchResult.category,
          research_type: researchDepth,
          status: 'completed',
          command_id: effectiveDbUuid || internalCommandId,
          metadata: {
            include_social_media: includeSocialMedia,
            include_competitor_analysis: includeCompetitorAnalysis,
            include_financial_info: includeFinancialInfo,
            research_areas: researchAreas || [],
            generated_at: researchResult.generated_at
          }
        };
        
        const { data, error } = await supabaseAdmin
          .from('lead_research')
          .insert([researchData])
          .select()
          .single();
        
        if (error) {
          console.error('Error al guardar resultado de investigación:', error);
        } else if (data) {
          savedResearch.push(data);
        }
      } catch (saveError) {
        console.error('Error al guardar resultado de investigación:', saveError);
      }
    }
    
    // Preparar la respuesta
    return NextResponse.json({
      success: true,
      data: {
        command_id: effectiveDbUuid || internalCommandId,
        site_id,
        lead_id,
        research_results: savedResearch.length > 0 ? savedResearch : researchResults,
        saved_to_database: savedResearch.length > 0,
        research_configuration: {
          depth: researchDepth,
          include_social_media: includeSocialMedia,
          include_competitor_analysis: includeCompetitorAnalysis,
          include_financial_info: includeFinancialInfo,
          research_areas: researchAreas || []
        }
      }
    });
    
  } catch (error) {
    console.error('Error general en la ruta de investigación de leads:', error);
    
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