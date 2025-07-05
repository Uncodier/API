import { NextResponse } from 'next/server';
import { 
  generateSearchTopic, 
  generateSearchPrompts, 
  generateContextMessage 
} from '@/lib/services/lead-generation/search-prompt-generator';
import { 
  getLeadsBySegmentAndStatus, 
  getOrCreateLeadGenMemory, 
  findActiveSalesAgent, 
  getAgentInfo 
} from '@/lib/services/lead-generation/database-service';
import { 
  createLeadGenerationCommand, 
  extractCommandResults 
} from '@/lib/services/lead-generation/command-service';
import { ProcessorInitializer } from '@/lib/agentbase';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Inicializar el agente y obtener el servicio de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Función para esperar a que un comando se complete
async function waitForCommandCompletion(commandId: string, maxAttempts = 100, delayMs = 1000) {
  let executedCommand = null;
  let attempts = 0;
  
  console.log(`⏳ Esperando a que se complete el comando ${commandId}...`);
  
  // Crear una promesa que se resuelve cuando el comando se completa o se agota el tiempo
  return new Promise<{command: any, completed: boolean}>((resolve) => {
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        executedCommand = await commandService.getCommandById(commandId);
        
        if (!executedCommand) {
          console.log(`⚠️ No se pudo encontrar el comando ${commandId}`);
          clearInterval(checkInterval);
          resolve({command: null, completed: false});
          return;
        }
        
        // Considerar comandos en estado 'failed' como completados si tienen resultados
        const hasResults = executedCommand.results && executedCommand.results.length > 0;
        const commandFinished = executedCommand.status === 'completed' || 
                               (executedCommand.status === 'failed' && hasResults);
                               
        if (commandFinished) {
          console.log(`✅ Comando ${commandId} terminado con estado: ${executedCommand.status}${hasResults ? ' (con resultados)' : ''}`);
          clearInterval(checkInterval);
          // Consideramos un comando fallido como "completado" si tiene resultados
          const effectivelyCompleted = executedCommand.status === 'completed' || 
                                     (executedCommand.status === 'failed' && hasResults);
          resolve({command: executedCommand, completed: effectivelyCompleted});
          return;
        }
        
        console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
          clearInterval(checkInterval);
          // Verificar si, a pesar del timeout, hay resultados utilizables
          const usableResults = executedCommand.results && executedCommand.results.length > 0;
          resolve({command: executedCommand, completed: usableResults});
        }
      } catch (error) {
        console.error(`Error al verificar estado del comando ${commandId}:`, error);
        clearInterval(checkInterval);
        resolve({command: null, completed: false});
      }
    }, delayMs);
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extract parameters from the request
    const { 
      siteId, 
      site_id,
      userId, 
      agent_id,
      maxLeads = 10,
      priority = "medium",
      webhook,
      business // Nuevo parámetro para contexto de negocio
    } = body;
    
    // Support both siteId and site_id formats
    const effectiveSiteId = siteId || site_id;
    
    // Validate required parameters
    if (!effectiveSiteId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId or site_id is required' } },
        { status: 400 }
      );
    }
    
    // Get agent info if agent_id is provided, otherwise try to find a sales agent
    let agentInfo: any = null;
    let effectiveUserId = userId;
    let effectiveAgentId = agent_id;
    
    if (agent_id) {
      // Si se proporciona agent_id específico, usar ese
      agentInfo = await getAgentInfo(agent_id);
      
      if (!agentInfo) {
        return NextResponse.json(
          { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } },
          { status: 404 }
        );
      }
      
      if (!effectiveUserId) {
        effectiveUserId = agentInfo.user_id;
      }
    } else {
      // Si no se proporciona agent_id, buscar agente de ventas automáticamente
      console.log(`🔍 No se proporcionó agent_id, buscando agente de ventas para sitio: ${effectiveSiteId}`);
      const salesAgent = await findActiveSalesAgent(effectiveSiteId);
      
      if (salesAgent) {
        effectiveAgentId = salesAgent.agentId;
        effectiveUserId = salesAgent.userId;
        agentInfo = await getAgentInfo(salesAgent.agentId);
        console.log(`✅ Agente de ventas encontrado automáticamente: ${salesAgent.agentId}`);
      }
    }
    
    if (!effectiveUserId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required and no sales agent found for automatic assignment' } },
        { status: 400 }
      );
    }
    
    // 1. Obtener leads convertidos y no convertidos por segmento
    const { convertedLeads, nonConvertedLeads, segments } = await getLeadsBySegmentAndStatus(effectiveSiteId);
    
    if (segments.length === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'NO_SEGMENTS_FOUND', message: 'No se encontraron segmentos activos para analizar' } },
        { status: 400 }
      );
    }
    
    // 2. Obtener memoria del agente para historial de búsquedas
    const { usedCities, usedRegions } = await getOrCreateLeadGenMemory(effectiveAgentId || 'default', effectiveUserId);
    
    // 3. Generar search_topic y prompts basados en los segmentos y leads exitosos
    const searchTopic = generateSearchTopic(segments, convertedLeads);
    const searchPrompts = generateSearchPrompts(segments, convertedLeads);
    
    // 4. Preparar contexto con análisis de segmentos y leads
    const contextMessage = generateContextMessage(
      segments,
      convertedLeads,
      nonConvertedLeads,
      searchTopic,
      searchPrompts,
      usedCities,
      usedRegions,
      maxLeads,
      webhook,
      business // Agregar contexto de negocio
    );
    
    // 5. Herramientas por defecto para lead generation
    const tools = (agentInfo && agentInfo.tools && Array.isArray(agentInfo.tools) && agentInfo.tools.length > 0) 
      ? agentInfo.tools 
      : [];
    
    // 6. Crear el comando
    console.log(`🚀 Creando comando de lead generation...`);
    const internalCommandId = await createLeadGenerationCommand(
      effectiveUserId,
      effectiveAgentId,
      effectiveSiteId,
      maxLeads,
      searchTopic,
      contextMessage,
      usedCities,
      usedRegions,
      tools,
      webhook
    );
    console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
    
    // 7. Esperar a que el comando se complete
    console.log(`⏳ Esperando completion del comando ${internalCommandId} (timeout: 150 intentos, 2s cada uno = 5 min max)`);
    const { command: executedCommand, completed } = await waitForCommandCompletion(internalCommandId, 150, 2000);
    
    // Si no completado, retornar error
    if (!completed) {
      console.warn(`⚠️ Comando ${internalCommandId} no completó exitosamente en el tiempo esperado`);
      
      if (!executedCommand || !executedCommand.results || executedCommand.results.length === 0) {
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
    
    // 8. Extraer los valores determinados por el agente
    console.log(`🎯 Extrayendo resultados del comando. Estado: ${executedCommand?.status || 'unknown'}, Resultados: ${executedCommand?.results?.length || 0}`);
    const { determinedCity, determinedRegion, determinedTopic } = extractCommandResults(executedCommand, searchTopic);
    
    // 9. Retornar respuesta con valores determinados por el agente
    console.log(`✅ Proceso completado exitosamente. Enviando respuesta con city: ${determinedCity}, region: ${determinedRegion}, topic: ${determinedTopic}`);
    return NextResponse.json({
      success: true,
      data: {
        command_id: internalCommandId,
        site_id: effectiveSiteId,
        agent_id: effectiveAgentId,
        agent_auto_assigned: !agent_id && !!effectiveAgentId,
        status: executedCommand?.status || "completed",
        completed_at: new Date().toISOString(),
        leads_requested: maxLeads,
        job_priority: priority,
        target_city: determinedCity,
        target_region: determinedRegion,
        search_topic: determinedTopic,
        segments_analyzed: segments.length,
        segment_insights: {
          converted_leads: convertedLeads.length,
          non_converted_leads: nonConvertedLeads.length,
          cities_previously_searched: usedCities.length,
          regions_previously_searched: Object.keys(usedRegions).reduce((total, city) => total + usedRegions[city].length, 0)
        },
        location_strategy: {
          method: "agent_determined_from_background",
          determined_location: determinedCity ? `${determinedCity}${determinedRegion ? `, ${determinedRegion}` : ''}` : null,
          previously_searched_cities: usedCities,
          note: "Location determined by agent based on business background/context"
        },
        process_info: {
          stage: "completed",
          progress_percentage: 100
        }
      }
    });
    
  } catch (error) {
    console.error('General error in lead generation route:', error);
    
    // Capturar más información del error para debugging
    const errorInfo = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 5).join('\n') // Primeras 5 líneas del stack
    } : { message: String(error) };
    
    console.error('Error details:', errorInfo);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: 'An internal system error occurred',
          ...(process.env.NODE_ENV === 'development' ? { debug: errorInfo } : {})
        } 
      },
      { status: 500 }
    );
  }
} 