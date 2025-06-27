import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { 
  getLeadInfo, 
  getPreviousInteractions, 
  buildEnrichedContext 
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



// Función genérica para encontrar un agente activo por role
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
      console.log(`⚠️ No active agent found with role "${role}" for site: ${siteId}`);
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

// Función para encontrar un agente de ventas activo para un sitio
async function findActiveSalesAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Sales/CRM Specialist');
}

// Función para encontrar un copywriter activo para un sitio
async function findActiveCopywriter(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Content Creator & Copywriter');
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

// Función para obtener la información del agente desde la base de datos
async function executeCopywriterRefinement(
  siteId: string,
  agentId: string,
  userId: string,
  baseContext: string,
  salesFollowUpContent: any[],
  leadId: string
): Promise<{ commandId: string; dbUuid: string | null; command: any } | null> {
  try {
    console.log(`📝 FASE 2: Ejecutando refinamiento de copywriter para agente: ${agentId}`);
    
    // Preparar contexto para la segunda fase incluyendo el resultado de la primera
    console.log(`📝 FASE 2: Preparando contexto para copywriter...`);
    let copywriterContext = baseContext;
    
    // Añadir resultado de la primera fase al contexto
    if (salesFollowUpContent && salesFollowUpContent.length > 0) {
      console.log(`📝 PHASE 2: Adding ${salesFollowUpContent.length} phase 1 results to context`);
      copywriterContext += `\n\n--- SALES TEAM INPUT (Phase 1 Results) ---\n`;
      copywriterContext += `The Sales/CRM Specialist has provided the following initial follow-up content that you need to refine:\n\n`;
      
      salesFollowUpContent.forEach((content: any, index: number) => {
        copywriterContext += `CONTENT ITEM ${index + 1}:\n`;
        copywriterContext += `├─ Channel: ${content.channel || 'Not specified'}\n`;
        copywriterContext += `├─ Title: ${content.title || 'Not specified'}\n`;
        copywriterContext += `├─ Strategy: ${content.strategy || 'Not specified'}\n`;
        copywriterContext += `└─ Message: ${content.message || 'Not specified'}\n\n`;
      });
      
      copywriterContext += `--- COPYWRITER INSTRUCTIONS ---\n`;
      copywriterContext += `Your task is to refine, improve, and enhance the selected content above with your copywriting expertise.\n`;
      copywriterContext += `IMPORTANT: The sales team has already selected the most effective channel${salesFollowUpContent.length > 1 ? 's' : ''} (${salesFollowUpContent.length} channel${salesFollowUpContent.length === 1 ? '' : 's'}) to avoid overwhelming the lead.\n`;
      copywriterContext += `For the selected content, you must:\n`;
      copywriterContext += `1. Maintain the original CHANNEL (email, whatsapp, notification, web)\n`;
      copywriterContext += `2. Preserve the core STRATEGY\n`;
      copywriterContext += `3. Improve the TITLE to make it more attractive and persuasive\n`;
      copywriterContext += `4. Perfect the MESSAGE with better copywriting and persuasion techniques\n`;
      copywriterContext += `5. Ensure the content resonates with the audience while maintaining sales objectives\n`;
      copywriterContext += `6. DO NOT use placeholders or variables like [Name], {Company}, {{Variable}}, etc.\n`;
      copywriterContext += `7. Use ONLY the real information provided in the lead context\n`;
      copywriterContext += `8. Write final content ready to send without additional editing\n\n`;
      copywriterContext += `9. Sign on behalf of the team (when relevant and the context merits adding a signature)\n\n`;
      
      console.log(`📝 FASE 2: Contexto estructurado preparado con ${copywriterContext.length} caracteres`);
    } else {
      console.log(`⚠️ PHASE 2: No follow-up content found in sales results`);
    }
    
    // Crear comando para copywriter basándose en los canales disponibles de la fase 1
    console.log(`🏗️ PHASE 2: Creating command for copywriter...`);
    console.log(`🏗️ PHASE 2: Parameters - userId: ${userId}, agentId: ${agentId}, siteId: ${siteId}`);
    
    // Construir dinámicamente los canales de refinamiento basándose en el contenido de la fase 1
    const refinementChannels: Array<{title: string, message: string, channel: string}> = [];
    
    if (salesFollowUpContent && salesFollowUpContent.length > 0) {
      salesFollowUpContent.forEach((content: any) => {
        const channel = content.channel;
        let refinedChannelContent: {title: string, message: string, channel: string} = {
          title: '',
          message: '',
          channel: channel
        };
        
        switch (channel) {
          case 'email':
            refinedChannelContent.title = "Refined and compelling email subject line that increases open rates";
            refinedChannelContent.message = "Enhanced email message with persuasive copy, clear value proposition, and strong call-to-action";
            break;
          case 'whatsapp':
            refinedChannelContent.title = "Improved WhatsApp message with casual yet professional tone";
            refinedChannelContent.message = "Refined WhatsApp content that feels personal, direct, and encourages immediate response";
            break;
          case 'notification':
            refinedChannelContent.title = "Enhanced in-app notification that captures attention";
            refinedChannelContent.message = "Optimized notification message that's concise, actionable, and drives user engagement";
            break;
          case 'web':
            refinedChannelContent.title = "Polished web popup/banner headline that converts";
            refinedChannelContent.message = "Compelling web message with persuasive copy that motivates visitors to take action";
            break;
          default:
            refinedChannelContent.title = `Refined ${channel} headline with improved copy`;
            refinedChannelContent.message = `Enhanced ${channel} message content with better persuasion and engagement`;
        }
        
        refinementChannels.push(refinedChannelContent);
      });
    }
    
          console.log(`📋 PHASE 2: Refinement channels configured: ${refinementChannels.map(c => c.channel).join(', ')}`);
    
    const copywriterCommand = CommandFactory.createCommand({
      task: 'lead nurture copywriting',
      userId: userId,
      agentId: agentId,
      site_id: siteId,
      description: 'Refine and enhance the carefully selected follow-up content created by the sales team. The sales team has already chosen the most effective channel to avoid overwhelming the lead. Improve the title and message copy while preserving the channel, strategy, and sales intent. Focus on delighting the lead and nurturing them for long term.',
      targets: [
        {
          deep_thinking: "Analyze the sales team's strategically selected follow-up content and create a refined approach for copywriting enhancement. Respect the channel selection made by the sales team."
        },
        {
          refined_content: refinementChannels
        }
      ],
      context: copywriterContext,
      supervisor: [
        {
          agent_role: 'creative_director',
          status: 'not_initialized'
        },
        {
          agent_role: 'sales_manager',
          status: 'not_initialized'
        }
      ]
    });
    
    console.log(`🏗️ PHASE 2: Command created, sending for processing...`);
    
    // Enviar comando de copywriter
    const copywriterCommandId = await commandService.submitCommand(copywriterCommand);
    console.log(`✅ PHASE 2: Copywriter command created successfully with internal ID: ${copywriterCommandId}`);
    
    // Esperar a que el comando de copywriter se complete
    console.log(`⏳ PHASE 2: Waiting for copywriter command completion...`);
    const result = await waitForCommandCompletion(copywriterCommandId);
    
    if (result && result.completed && result.command) {
      console.log(`✅ PHASE 2: Copywriter command completed successfully`);
      
      // Extraer contenido refinado de los resultados
      let refinedContent = [];
      if (result.command.results && Array.isArray(result.command.results)) {
        for (const commandResult of result.command.results) {
          if (commandResult.refined_content && Array.isArray(commandResult.refined_content)) {
            refinedContent = commandResult.refined_content;
            break;
          }
        }
      }
      
      console.log(`📊 PHASE 2: Refined content extracted:`, JSON.stringify(refinedContent, null, 2));
      
      return {
        commandId: copywriterCommandId,
        dbUuid: result.dbUuid,
        command: result.command
      };
    } else {
      console.error(`❌ PHASE 2: Copywriter command did not complete correctly`);
      return null;
    }
  } catch (error: any) {
    console.error(`❌ PHASE 2: Error creating/executing copywriter command:`, error);
    return null;
  }
}

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
    
    // Buscar agente de ventas activo si no se proporciona un agent_id
    let effectiveAgentId = agent_id;
    let agentInfo: any = null;
    let effectiveUserId = userId;
    
    if (!effectiveAgentId) {
      // Buscar un agente activo en la base de datos para el sitio
      const foundAgent = await findActiveSalesAgent(siteId);
      if (foundAgent) {
        effectiveAgentId = foundAgent.agentId;
        effectiveUserId = foundAgent.userId;
        console.log(`🤖 Usando agente de ventas encontrado: ${effectiveAgentId} (user_id: ${effectiveUserId})`);
      } else {
        console.log(`⚠️ No se encontró un agente activo para el sitio: ${siteId}`);
      }
    } else if (isValidUUID(effectiveAgentId)) {
      // Si ya tenemos un agentId válido, obtenemos su información completa
      agentInfo = await getAgentInfo(effectiveAgentId);
      if (agentInfo) {
        // Si no se proporcionó un userId, usar el del agente
        if (!effectiveUserId) {
          effectiveUserId = agentInfo.user_id;
        }
      } else {
        return NextResponse.json(
          { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } },
          { status: 404 }
        );
      }
    }
    
    // Si aún no tenemos un userId, error
    if (!effectiveUserId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required and no active agent found for the site' } },
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
      
      // Añadir información del sitio si está disponible
      if (effectiveLeadData.sites) {
        contextMessage += `\nSite: ${effectiveLeadData.sites.name} (${effectiveLeadData.sites.url})`;
      }
      
      // Añadir información del visitor si está disponible
      if (effectiveLeadData.visitors) {
        if (effectiveLeadData.visitors.user_agent) {
          contextMessage += `\nUser Agent: ${effectiveLeadData.visitors.user_agent}`;
        }
        if (effectiveLeadData.visitors.location) {
          contextMessage += `\nLocation: ${effectiveLeadData.visitors.location}`;
        }
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
    
    // Añadir contexto enriquecido con contenidos, tareas y conversaciones
    console.log(`🔍 Construyendo contexto enriquecido para el comando...`);
    const enrichedContext = await buildEnrichedContext(siteId, leadId);
    if (enrichedContext) {
      contextMessage += `\n\n${enrichedContext}`;
      console.log(`✅ Contexto enriquecido añadido (${enrichedContext.length} caracteres)`);
    } else {
      console.log(`⚠️ No se pudo obtener contexto enriquecido`);
    }
    

    // Determinar qué canales de comunicación están disponibles
    const hasEmail = effectiveLeadData && effectiveLeadData.email && effectiveLeadData.email.trim() !== '';
    const hasPhone = effectiveLeadData && effectiveLeadData.phone && effectiveLeadData.phone.trim() !== '';
    
    console.log(`📞 Canales disponibles - Email: ${hasEmail ? 'SÍ' : 'NO'}, Phone: ${hasPhone ? 'SÍ' : 'NO'}`);
    
    // Construir dinámicamente los canales de follow-up basándose en la información disponible
    const followUpChannels = [];
    
    // Agregar email si está disponible
    if (hasEmail) {
      followUpChannels.push({
        strategy: "comprehensive sale strategy",
        title: "Email subject line for follow-up",
        message: "Personalized email message content with professional tone",
        channel: "email"
      });
    }
    
    // Agregar WhatsApp si hay teléfono disponible
    if (hasPhone) {
      followUpChannels.push({
        strategy: "comprehensive sale strategy",
        title: "WhatsApp follow-up message title",
        message: "Casual and direct WhatsApp message content",
        channel: "whatsapp"
      });
    }
    
    // Siempre agregar canales web y notification (no dependen de datos específicos del lead)
    followUpChannels.push({
      strategy: "comprehensive sale strategy",
      title: "In-app notification title",
      message: "Concise notification message for the dashboard",
      channel: "notification"
    });
    
    followUpChannels.push({
      strategy: "comprehensive sale strategy",
      title: "Web popup/banner title",
      message: "Engaging web message content for site visitors",
      channel: "web"
    });
    
    console.log(`📋 Canales de follow-up configurados: ${followUpChannels.map(c => c.channel).join(', ')}`);

    // Agregar instrucciones específicas sobre selección de canal al contexto
    contextMessage += `\n\n=== INSTRUCCIONES CRÍTICAS SOBRE SELECCIÓN DE CANAL ===\n`;
    contextMessage += `ATENCIÓN: De los ${followUpChannels.length} canales disponibles (${followUpChannels.map(c => c.channel).join(', ')}), debes seleccionar ÚNICAMENTE EL MÁS EFECTIVO.\n`;
    contextMessage += `\nCRITERIOS DE SELECCIÓN:\n`;
    contextMessage += `1. Email: Ideal para leads profesionales, información detallada, documentos adjuntos\n`;
    contextMessage += `2. WhatsApp: Perfecto para comunicación inmediata, leads que prefieren mensajería móvil\n`;
    contextMessage += `3. Notification: Ideal para usuarios activos en la plataforma, mensajes cortos y directos\n`;
    contextMessage += `4. Web: Efectivo para visitors que aún navegan el sitio web, ofertas y demos\n`;
    contextMessage += `\nDEBES RETORNAR SOLO 1 CANAL en el follow_up_content para no hostigar al lead.\n`;
    contextMessage += `Basa tu decisión en el historial, contexto y perfil del lead mostrado arriba.\n`;
    contextMessage += `=== FIN DE INSTRUCCIONES ===\n\n`;

    // FASE 1: Crear el comando para el Sales/CRM Specialist
    console.log(`🚀 FASE 1: Creando comando para Sales/CRM Specialist`);
    const salesCommand = CommandFactory.createCommand({
      task: 'lead follow-up strategy',
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      site_id: siteId,
      description: 'Generate a personalized follow-up sequence for a qualified lead, focusing on addressing their pain points and interests, with appropriate timing between touchpoints. You want to delight and nurture the lead. IMPORTANTE: Basándote en el historial del lead, su perfil y contexto, selecciona SOLO el canal más efectivo para no hostigar al usuario. Debes elegir únicamente 1 canal de los disponibles, el que tenga mayor probabilidad de éxito según el contexto del lead.',
      targets: [
        {
          deep_thinking: "Analyze the lead information, their interaction history, preferences, and profile to determine the single most effective communication channel. Consider factors like: lead's communication preferences, previous interactions, urgency level, lead stage, and professional context. Choose only ONE channel to avoid overwhelming the lead."
        },
        {
          follow_up_content: followUpChannels
        }
      ],
      context: contextMessage,
      supervisor: [
        {
          agent_role: 'sales_manager',
          status: 'not_initialized'
        },
        {
          agent_role: 'customer_success',
          status: 'not_initialized'
        }
      ]
    });
    
    // Enviar el comando para procesamiento de forma asíncrona
    const salesCommandId = await commandService.submitCommand(salesCommand);
    console.log(`📝 FASE 1: Comando de ventas creado con ID interno: ${salesCommandId}`);
    
    // Esperar a que el comando de ventas se complete
    console.log(`⏳ PHASE 1: Waiting for sales command completion...`);
    const { command: completedSalesCommand, dbUuid: salesDbUuid, completed: salesCompleted } = await waitForCommandCompletion(salesCommandId);
    
    if (!salesCompleted || !completedSalesCommand) {
      console.error(`❌ FASE 1: El comando de ventas no se completó correctamente`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'SALES_COMMAND_FAILED', 
            message: 'Sales command did not complete successfully' 
          } 
        },
        { status: 500 }
      );
    }
    
    console.log(`✅ FASE 1: Comando de ventas completado exitosamente`);
    console.log(`📊 FASE 1: Resultados obtenidos:`, JSON.stringify(completedSalesCommand.results, null, 2));
    
    // Extraer contenido de follow-up de los resultados
    let salesFollowUpContent = [];
    if (completedSalesCommand.results && Array.isArray(completedSalesCommand.results)) {
      console.log(`🔍 FASE 1: Estructura completa de resultados:`, JSON.stringify(completedSalesCommand.results, null, 2));
      
      for (const result of completedSalesCommand.results) {
        console.log(`🔍 FASE 1: Analizando resultado:`, Object.keys(result));
        
        // Buscar follow_up_content
        if (result.follow_up_content && Array.isArray(result.follow_up_content)) {
          salesFollowUpContent = result.follow_up_content;
          console.log(`✅ FASE 1: Encontrado follow_up_content con ${salesFollowUpContent.length} elementos`);
          break;
        }
        
        // Buscar otras posibles estructuras
        if (result.content && Array.isArray(result.content)) {
          salesFollowUpContent = result.content;
          console.log(`✅ FASE 1: Encontrado content con ${salesFollowUpContent.length} elementos`);
          break;
        }
        
        // Buscar targets (fallback)
        if (result.targets && Array.isArray(result.targets)) {
          salesFollowUpContent = result.targets;
          console.log(`✅ FASE 1: Encontrado targets con ${salesFollowUpContent.length} elementos`);
          break;
        }
        
        // Si el resultado es directamente un array
        if (Array.isArray(result)) {
          salesFollowUpContent = result;
          console.log(`✅ FASE 1: Resultado es array directo con ${salesFollowUpContent.length} elementos`);
          break;
        }
      }
    }
    
          console.log(`📊 PHASE 1: Follow-up content extracted:`, JSON.stringify(salesFollowUpContent, null, 2));
    
    // Verificar si tenemos contenido válido
    if (!salesFollowUpContent || salesFollowUpContent.length === 0) {
      console.error(`❌ FASE 1: No se pudo extraer contenido de follow-up de los resultados`);
      console.log(`🔍 FASE 1: Estructura de resultados disponible:`, JSON.stringify(completedSalesCommand.results, null, 2));
    }
    
    // FASE 2: Buscar copywriter y crear segundo comando
            console.log(`🚀 PHASE 2: Starting copywriter search for site: ${siteId}`);
    
    // Buscar copywriter activo
    const copywriterAgent = await findActiveCopywriter(siteId);
    let copywriterAgentId: string | null = null;
    let copywriterUserId = effectiveUserId; // Fallback al userId original
    let shouldExecutePhase2 = false;
    
    if (copywriterAgent) {
      copywriterAgentId = copywriterAgent.agentId;
      copywriterUserId = copywriterAgent.userId;
      shouldExecutePhase2 = true;
      console.log(`🤖 FASE 2: Copywriter encontrado exitosamente: ${copywriterAgentId} (user_id: ${copywriterUserId})`);
    } else {
              console.log(`⚠️ PHASE 2: No active copywriter found for site: ${siteId}`);
      console.log(`⚠️ FASE 2: Saltando segunda fase - solo ejecutaremos fase de ventas`);
    }
    
    // Variables para la fase 2
    let copywriterCommandId: string | null = null;
    let copywriterDbUuid: string | null = null;
    let completedCopywriterCommand: any = null;
    let copywriterCompleted = false;
    
    // Solo ejecutar fase 2 si hay copywriter disponible Y contenido de ventas
    if (shouldExecutePhase2 && copywriterAgentId && typeof copywriterAgentId === 'string' && salesFollowUpContent.length > 0) {
      console.log(`🚀 FASE 2: Ejecutando fase de copywriter...`);
      
      // Ejecutar función helper para copywriter
      const copywriterResult = await executeCopywriterRefinement(
        siteId,
        copywriterAgentId,
        copywriterUserId,
        contextMessage,
        salesFollowUpContent, // Pasar el contenido extraído en lugar del comando completo
        leadId
      );
      
      if (copywriterResult) {
        copywriterCommandId = copywriterResult.commandId;
        copywriterDbUuid = copywriterResult.dbUuid;
        completedCopywriterCommand = copywriterResult.command;
        copywriterCompleted = true;
        console.log(`✅ FASE 2: Comando de copywriter completado exitosamente`);
      } else {
        console.error(`❌ FASE 2: El comando de copywriter no se completó correctamente`);
      }
    } else {
      if (!shouldExecutePhase2) {
        console.log(`⏭️ FASE 2: Saltando fase de copywriter - no hay agente disponible`);
      } else if (!copywriterAgentId) {
        console.log(`⏭️ FASE 2: Saltando fase de copywriter - agentId es null`);
      } else if (salesFollowUpContent.length === 0) {
        console.log(`⏭️ FASE 2: Saltando fase de copywriter - no hay contenido de ventas para refinar`);
      } else {
        console.log(`⏭️ PHASE 2: Skipping copywriter phase - condition not met`);
      }
    }
    
    // Extraer mensajes del resultado final (priorizar copywriter si existe)
    const finalCommand = copywriterCompleted ? completedCopywriterCommand : completedSalesCommand;
    let finalContent = [];
    
    // Extraer contenido del comando final
    if (finalCommand && finalCommand.results && Array.isArray(finalCommand.results)) {
      for (const result of finalCommand.results) {
        // Para copywriter, buscar refined_content
        if (copywriterCompleted && result.refined_content && Array.isArray(result.refined_content)) {
          finalContent = result.refined_content;
          break;
        }
        // Para sales, buscar follow_up_content
        else if (!copywriterCompleted && result.follow_up_content && Array.isArray(result.follow_up_content)) {
          finalContent = result.follow_up_content;
          break;
        }
        // Fallbacks
        else if (result.content && Array.isArray(result.content)) {
          finalContent = result.content;
          break;
        }
        else if (Array.isArray(result)) {
          finalContent = result;
          break;
        }
      }
    }
    
    // Organizar mensajes por canal
    const messages: any = {};
    
    if (finalContent && Array.isArray(finalContent)) {
      finalContent.forEach((item: any) => {
        if (item.channel) {
          messages[item.channel] = {
            title: item.title || '',
            message: item.message || '',
            strategy: item.strategy || ''
          };
        }
      });
    }
    
    console.log(`🚀 Secuencia completada - Sales: ${salesCompleted ? 'EXITOSO' : 'FALLIDO'}, Copywriter: ${copywriterCompleted ? 'EXITOSO' : 'FALLIDO'}`);
    console.log(`📦 Mensajes estructurados por canal:`, Object.keys(messages));
    
    return NextResponse.json({
      success: true,
      data: {
        messages: messages,
        lead: effectiveLeadData || {},
        command_ids: {
          sales: salesCommandId,
          copywriter: copywriterCommandId
        }
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