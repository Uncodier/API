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
    

    
    // Crear el comando usando CommandFactory
    const command = CommandFactory.createCommand({
      task: 'create lead follow-up sequence',
      userId: effectiveUserId,
      agentId: agent_id,
      // Agregar site_id como propiedad básica
      site_id: siteId,
      description: 'Generate a personalized follow-up sequence for a qualified lead, focusing on addressing their pain points and interests, with appropriate timing between touchpoints.',
      // Establecer los targets como objetos separados para cada canal
      targets: [
        {
          title: "Email subject line for follow-up",
          message: "Personalized email message content with professional tone",
          channel: "email"
        },
        {
          title: "WhatsApp follow-up message title",
          message: "Casual and direct WhatsApp message content",
          channel: "whatsapp"
        },
        {
          title: "In-app notification title",
          message: "Concise notification message for the dashboard",
          channel: "notification"
        },
        {
          title: "Web popup/banner title",
          message: "Engaging web message content for site visitors",
          channel: "web"
        }
      ],

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
    
    // Enviar el comando para procesamiento de forma asíncrona
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando de seguimiento de lead creado con ID interno: ${internalCommandId}`);
    
    // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
    let initialDbUuid = await getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
    }
    
    // Devolver respuesta inmediatamente indicando que el comando se está procesando
    console.log(`🚀 Comando enviado para procesamiento asíncrono: ${internalCommandId}`);
    
    // Preparar la respuesta inmediata
    return NextResponse.json({
      success: true,
      data: {
        command_id: initialDbUuid || internalCommandId,
        siteId,
        leadId,
        status: 'processing',
        message: 'Lead follow-up sequence is being generated. Check the status using the command_id.',
        processing_started_at: new Date().toISOString()
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