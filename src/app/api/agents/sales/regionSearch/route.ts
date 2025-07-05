import { NextResponse } from 'next/server';
import { 
  generateBusinessResearchTopic, 
  generateBusinessTypePrompts,
  generateBusinessTypeContextMessage 
} from '@/lib/services/lead-generation/business-type-generator';
import { 
  getOrCreateLeadGenMemory, 
  findActiveSalesAgent, 
  getAgentInfo,
  getRegionBusinessInsights
} from '@/lib/services/lead-generation/database-service';
import { 
  createBusinessTypeResearchCommand, 
  extractBusinessTypeResults 
} from '@/lib/services/lead-generation/command-service';
import { ProcessorInitializer } from '@/lib/agentbase';

// Inicializar el agente y obtener el servicio de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Función para esperar a que un comando se complete de manera más robusta
async function waitForCommandCompletion(commandId: string, maxAttempts = 180, delayMs = 2000) {
  let executedCommand: any = null;
  let attempts = 0;
  let lastStatus: string | null = null;
  let lastResultCount = 0;
  let stableCount = 0; // Contador para verificar que el comando esté realmente estable
  
  console.log(`⏳ Esperando a que se complete el comando ${commandId}... (máx ${maxAttempts} intentos, ${delayMs}ms c/u)`);
  
  return new Promise<{command: any, completed: boolean}>((resolve) => {
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        executedCommand = await commandService.getCommandById(commandId);
        
        if (!executedCommand) {
          console.log(`⚠️ No se pudo encontrar el comando ${commandId} (intento ${attempts})`);
          if (attempts >= 5) { // Dar más oportunidades al inicio
            clearInterval(checkInterval);
            resolve({command: null, completed: false});
            return;
          }
          return; // Continuar intentando
        }
        
        const hasResults = executedCommand.results && executedCommand.results.length > 0;
        const currentResultCount = executedCommand.results?.length || 0;
        const currentStatus = executedCommand.status;
        
        // Log detallado del progreso
        if (attempts % 10 === 0 || currentStatus !== lastStatus || currentResultCount !== lastResultCount) {
          console.log(`📊 Comando ${commandId} - Estado: ${currentStatus}, Resultados: ${currentResultCount}, Intento: ${attempts}/${maxAttempts}`);
        }
        
        // Verificar si el comando está realmente terminado
        const commandFinished = currentStatus === 'completed' || 
                               (currentStatus === 'failed' && hasResults);
        
        if (commandFinished) {
          // Verificar estabilidad: que el comando mantenga el mismo estado y resultados por varios checks
          if (currentStatus === lastStatus && currentResultCount === lastResultCount) {
            stableCount++;
          } else {
            stableCount = 0;
          }
          
          // Si el comando está estable por al menos 2 checks, considerarlo terminado
          if (stableCount >= 2) {
            console.log(`✅ Comando ${commandId} terminado establemente - Estado: ${currentStatus}, Resultados: ${currentResultCount}`);
            clearInterval(checkInterval);
            const effectivelyCompleted = currentStatus === 'completed' || 
                                        (currentStatus === 'failed' && hasResults);
            resolve({command: executedCommand, completed: effectivelyCompleted});
            return;
          } else {
            console.log(`⏳ Comando ${commandId} parece terminado pero verificando estabilidad... (${stableCount}/2)`);
          }
        } else {
          // Resetear contador de estabilidad si el comando aún no está terminado
          stableCount = 0;
          
          // Log cada 30 segundos para comandos que tardan mucho
          if (attempts % 15 === 0) {
            console.log(`⏳ Comando ${commandId} aún procesándose - Estado: ${currentStatus}, Resultados: ${currentResultCount}`);
          }
        }
        
        // Actualizar valores para el próximo check
        lastStatus = currentStatus;
        lastResultCount = currentResultCount;
        
        // Timeout con resultados utilizables
        if (attempts >= maxAttempts) {
          console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
          console.log(`📊 Estado final: ${currentStatus}, Resultados: ${currentResultCount}`);
          clearInterval(checkInterval);
          const usableResults = hasResults;
          resolve({command: executedCommand, completed: usableResults});
        }
      } catch (error) {
        console.error(`❌ Error al verificar estado del comando ${commandId} (intento ${attempts}):`, error);
        if (attempts >= 10) { // Dar más oportunidades en caso de errores temporales
          clearInterval(checkInterval);
          resolve({command: null, completed: false});
        }
      }
    }, delayMs);
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    console.log('📥 regionSearch request received:', {
      siteId: body.siteId || 'not provided',
      site_id: body.site_id || 'not provided', 
      userId: body.userId || 'not provided',
      agent_id: body.agent_id || 'not provided',
      region: body.region || 'not provided',
      businessType: body.businessType || 'not provided',
      keywords: body.keywords || 'not provided'
    });
    
    // Extraer parámetros de la solicitud
    const { 
      siteId,
      site_id,
      userId, 
      agent_id,
      region,
      businessType = '',
      keywords = [],
      maxBusinessTypes = 3,
      priority = "medium",
      webhook
    } = body;
    
    // Support both siteId and site_id formats
    const effectiveSiteId = siteId || site_id;
    
    // Validate required parameters
    if (!effectiveSiteId) {
      console.error('❌ Missing required parameter: siteId or site_id');
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId or site_id is required' } },
        { status: 400 }
      );
    }
    
    // Note: region is now optional - agent will determine target region automatically
    
    // Get agent info if agent_id is provided, otherwise try to find a sales agent
    let agentInfo: any = null;
    let effectiveUserId = userId;
    let effectiveAgentId = agent_id;
    
    if (agent_id) {
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
      console.error('❌ Missing required parameter: userId and no sales agent found for automatic assignment');
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required and no sales agent found for automatic assignment' } },
        { status: 400 }
      );
    }
    
    // 1. Obtener memoria del agente para historial de búsquedas
    const { usedCities, usedRegions } = await getOrCreateLeadGenMemory(effectiveAgentId || 'default', effectiveUserId);
    
    // 2. Obtener insights de negocios de la región (o usar datos generales si no hay región específica)
    const regionInsights = region ? await getRegionBusinessInsights(region) : {
      popularIndustries: ['Local services', 'Small business', 'Retail', 'Restaurants', 'Professional services'],
      growingBusinessTypes: ['Digital services', 'E-commerce', 'Local food', 'Wellness', 'Home services'],
      marketTrends: ['Digital adoption', 'Local consumption', 'Service economy'],
      economicData: {},
      competitorAnalysis: {
        dominantTypes: ['Local services'],
        gaps: ['Digital services']
      }
    };
    
    // 3. Generar business_research_topic basado en la región y tipo de negocio
    const targetRegion = region || "to be determined by agent";
    const businessResearchTopic = generateBusinessResearchTopic(targetRegion, businessType, keywords, regionInsights);
    const businessTypePrompts = generateBusinessTypePrompts(targetRegion, businessType, keywords, regionInsights);
    
    // 4. Preparar contexto para generar tipos de negocios
    const contextMessage = generateBusinessTypeContextMessage(
      targetRegion,
      businessType,
      keywords,
      regionInsights,
      businessResearchTopic,
      businessTypePrompts,
      usedCities,
      usedRegions,
      maxBusinessTypes,
      webhook
    );
    
    // 5. Herramientas por defecto para business type research
    const tools = (agentInfo && agentInfo.tools && Array.isArray(agentInfo.tools) && agentInfo.tools.length > 0) 
      ? agentInfo.tools 
      : [];
    
    // 6. Crear el comando para investigación de tipos de negocios
    console.log(`🚀 Creando comando de investigación de tipos de negocios para región: ${targetRegion}...`);
    const internalCommandId = await createBusinessTypeResearchCommand(
      effectiveUserId,
      effectiveAgentId,
      effectiveSiteId,
      targetRegion,
      businessType,
      keywords,
      maxBusinessTypes,
      businessResearchTopic,
      contextMessage,
      tools,
      webhook
    );
    console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
    
    // 7. Esperar a que el comando se complete con verificación de estabilidad
    console.log(`⏳ Esperando completion del comando ${internalCommandId} (timeout: 180 intentos, 2s cada uno = 6 min max)`);
    const { command: executedCommand, completed } = await waitForCommandCompletion(internalCommandId, 180, 2000);
    
    // 8. Extraer los tipos de negocios determinados por el agente
    console.log(`🎯 Extrayendo resultados del comando. Estado: ${executedCommand?.status || 'unknown'}, Resultados: ${executedCommand?.results?.length || 0}`);
    
    // Verificar si tenemos resultados utilizables independientemente del estado de completion
    if (!executedCommand) {
      console.error(`❌ No se pudo obtener el comando ejecutado`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'No se pudo obtener información del comando ejecutado' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Verificar si hay resultados utilizables (similar a chat/message)
    const hasUsableResults = executedCommand.results && executedCommand.results.length > 0;
    
    if (!completed && !hasUsableResults) {
      console.warn(`⚠️ Comando ${internalCommandId} no completó exitosamente y no hay resultados utilizables`);
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
    }
    
    // Si hay resultados utilizables, continuar con el procesamiento (aunque no haya completado)
    if (!completed && hasUsableResults) {
      console.log(`⚠️ Comando en estado ${executedCommand.status} pero tiene ${executedCommand.results.length} resultados, continuando con procesamiento`);
    }
    
    const { businessTypes, determinedTopic, determinedCity, determinedRegion } = extractBusinessTypeResults(executedCommand, businessResearchTopic);
    
    // Verificar que se extrajeron business types válidos
    if (!businessTypes || businessTypes.length === 0) {
      console.warn(`⚠️ No se pudieron extraer business types válidos de los resultados`);
      // En lugar de fallar, devolver una respuesta con business types vacíos pero exitosa
      return NextResponse.json({
        success: true,
        data: {
          command_id: internalCommandId,
          site_id: effectiveSiteId,
          agent_id: effectiveAgentId,
          agent_auto_assigned: !agent_id && !!effectiveAgentId,
          status: executedCommand.status || "completed_with_warnings",
          completed_at: new Date().toISOString(),
          target_city: determinedCity,
          target_region: determinedRegion,
          initial_region_input: region || null,
          business_types_requested: maxBusinessTypes,
          business_research_topic: determinedTopic,
          business_types: [], // Array vacío pero estructura válida
          region_insights: regionInsights,
          search_context: {
            initial_business_type: businessType,
            keywords_provided: keywords,
            region_provided: region || null,
            region_determined: determinedRegion
          },
          location_strategy: {
            method: "agent_determined_from_background",
            determined_location: determinedCity ? `${determinedCity}${determinedRegion ? `, ${determinedRegion}` : ''}` : determinedRegion,
            previously_searched_cities: usedCities,
            note: "Location determined by agent based on business background/context or market analysis"
          },
          process_info: {
            stage: "completed_with_warnings",
            progress_percentage: 100,
            warning: "No business types were extracted from the results"
          }
        }
      });
    }
    
    // 9. Retornar respuesta con tipos de negocios determinados por el agente
    console.log(`✅ Proceso completado exitosamente. Enviando respuesta con ${businessTypes.length} tipos de negocios`);
    console.log(`🎯 Ciudad determinada: ${determinedCity}, Región determinada: ${determinedRegion}`);
    return NextResponse.json({
      success: true,
      data: {
        command_id: internalCommandId,
        site_id: effectiveSiteId,
        agent_id: effectiveAgentId,
        agent_auto_assigned: !agent_id && !!effectiveAgentId,
        status: executedCommand?.status || "completed",
        completed_at: new Date().toISOString(),
        target_city: determinedCity,
        target_region: determinedRegion,
        initial_region_input: region || null,
        business_types_requested: maxBusinessTypes,
        business_research_topic: determinedTopic,
        business_types: businessTypes,
        region_insights: regionInsights,
        search_context: {
          initial_business_type: businessType,
          keywords_provided: keywords,
          region_provided: region || null,
          region_determined: determinedRegion
        },
        location_strategy: {
          method: "agent_determined_from_background",
          determined_location: determinedCity ? `${determinedCity}${determinedRegion ? `, ${determinedRegion}` : ''}` : determinedRegion,
          previously_searched_cities: usedCities,
          note: "Location determined by agent based on business background/context or market analysis"
        },
        process_info: {
          stage: "completed",
          progress_percentage: 100
        }
      }
    });
    
  } catch (error) {
    console.error('General error in region search route:', error);
    
    const errorInfo = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 5).join('\n')
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