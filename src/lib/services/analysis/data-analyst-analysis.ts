import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { v4 as uuidv4 } from 'uuid';
import { waitForCommandCompletion } from '@/lib/helpers/command-utils';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para encontrar agente con role "Data Analyst"
export async function findDataAnalystAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for Data Analyst agent search: ${siteId}`);
      return null;
    }
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', 'Data Analyst')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error al buscar agente con role "Data Analyst":', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente con role "Data Analyst" activo para el sitio: ${siteId}`);
      return null;
    }
    
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error al buscar agente Data Analyst:', error);
    return null;
  }
}

// Función para obtener memorias de búsqueda del agente
export async function getAgentSearchMemories(agentId: string, timeRange?: {from?: string, to?: string}, limit: number = 50, commandId?: string): Promise<{success: boolean, memories?: any[], error?: string}> {
  try {
    console.log(`🧠 Obteniendo memorias de búsqueda para agente: ${agentId}${commandId ? ` y comando: ${commandId}` : ''}`);
    
    let query = supabaseAdmin
      .from('agent_memories')
      .select('*')
      .eq('agent_id', agentId)
      .eq('type', 'search_results')
      .order('created_at', { ascending: false })
      .limit(limit);
    
    // Filtrar por command_id si se proporciona y es un UUID válido
    if (commandId) {
      if (isValidUUID(commandId)) {
        // Si es UUID válido, buscar en la columna command_id
        query = query.eq('command_id', commandId);
      } else {
        // Si no es UUID válido, buscar en data.original_command_id o metadata.original_command_id
        console.log(`⚠️ command_id '${commandId}' no es un UUID válido, buscando por original_command_id en data/metadata`);
        // Para buscar en JSON, necesitamos usar una query diferente
        // Debido a las limitaciones de Supabase, vamos a obtener todas las memorias y filtrar localmente
        console.log(`⚠️ Filtrando memorias localmente por original_command_id: ${commandId}`);
      }
    }
    
    // Aplicar filtros de tiempo si se proporcionan
    if (timeRange?.from) {
      query = query.gte('created_at', timeRange.from);
    }
    if (timeRange?.to) {
      query = query.lte('created_at', timeRange.to);
    }
    
    const { data, error } = await query;
    
    if (error) {
      console.error('❌ Error obteniendo memorias del agente:', error);
      return {
        success: false,
        error: error.message
      };
    }
    
    let filteredData = data || [];
    
    // Si el commandId no es UUID válido, filtrar localmente por original_command_id
    if (commandId && !isValidUUID(commandId)) {
      filteredData = (data || []).filter(memory => {
        const dataObj = memory.data || {};
        const metadataObj = memory.metadata || {};
        return dataObj.original_command_id === commandId || metadataObj.original_command_id === commandId;
      });
      console.log(`🔍 Filtrado local: ${filteredData.length} memorias encontradas con original_command_id: ${commandId}`);
    }
    
    console.log(`✅ Encontradas ${filteredData.length} memorias de búsqueda`);
    
    return {
      success: true,
      memories: filteredData
    };
    
  } catch (error) {
    console.error('❌ Error en getAgentSearchMemories:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

// Función para consolidar y estructurar datos de memorias
export function consolidateSearchMemories(memories: any[]): {
  total_searches: number;
  search_queries: string[];
  all_results: any[];
  consolidated_findings: any[];
  sources: string[];
  answers: string[];
  search_timeframe: {from: string, to: string};
} {
  const searchQueries: string[] = [];
  const allResults: any[] = [];
  const consolidatedFindings: any[] = [];
  const sources: string[] = [];
  const answers: string[] = [];
  let earliestSearch = new Date().toISOString();
  let latestSearch = new Date(0).toISOString();
  
  memories.forEach((memory) => {
    const memoryData = memory.data || {};
    
    // Recopilar queries
    if (memoryData.search_query) {
      searchQueries.push(memoryData.search_query);
    }
    
    // Recopilar todos los resultados
    if (memoryData.results && Array.isArray(memoryData.results)) {
      allResults.push(...memoryData.results);
      
      // Procesar cada resultado
      memoryData.results.forEach((result: any) => {
        if (result.url && !sources.includes(result.url)) {
          sources.push(result.url);
        }
        
        // Consolidar hallazgos
        consolidatedFindings.push({
          query: memoryData.search_query,
          title: result.title || '',
          content: result.content || '',
          url: result.url || '',
          score: result.score || 0,
          published_date: result.published_date || null,
          search_timestamp: memoryData.search_timestamp
        });
      });
    }
    
    // Recopilar respuestas
    if (memoryData.answer) {
      answers.push(memoryData.answer);
    }
    
    // Actualizar rango de tiempo
    const searchTime = memoryData.search_timestamp || memory.created_at;
    if (searchTime < earliestSearch) earliestSearch = searchTime;
    if (searchTime > latestSearch) latestSearch = searchTime;
  });
  
  return {
    total_searches: memories.length,
    search_queries: Array.from(new Set(searchQueries)), // Eliminar duplicados
    all_results: allResults,
    consolidated_findings: consolidatedFindings,
    sources: Array.from(new Set(sources)), // Eliminar duplicados
    answers: answers,
    search_timeframe: {
      from: earliestSearch,
      to: latestSearch
    }
  };
}

// Función principal para ejecutar análisis de datos
export async function executeDataAnalysis(
  siteId: string,
  analysisType: string = 'comprehensive',
  agentId?: string,
  commandId?: string,
  data?: any,
  timeRange?: {from?: string, to?: string},
  memoryLimit: number = 50,
  includeRawData: boolean = false,
  deliverables?: any
): Promise<{success: boolean, data?: any, error?: string}> {
  try {
    // Validar parámetros
    if (!siteId || !isValidUUID(siteId)) {
      return {
        success: false,
        error: 'site_id must be a valid UUID'
      };
    }
    
    // Buscar agente Data Analyst
    let dataAnalystAgent = null;
    
    if (agentId && isValidUUID(agentId)) {
      // Si se proporciona agent_id específico, verificar que existe
      const { data: agentData, error } = await supabaseAdmin
        .from('agents')
        .select('id, user_id')
        .eq('id', agentId)
        .single();
      
      if (!error && agentData) {
        dataAnalystAgent = {
          agentId: agentData.id,
          userId: agentData.user_id
        };
      }
    }
    
    if (!dataAnalystAgent) {
      dataAnalystAgent = await findDataAnalystAgent(siteId);
    }
    
    if (!dataAnalystAgent) {
      return {
        success: false,
        error: 'No se encontró un agente con role "Data Analyst" para este sitio'
      };
    }
    
    console.log(`📊 Iniciando análisis para agente: ${dataAnalystAgent.agentId}`);
    
    let consolidatedData = null;
    let memoriesData = null;
    
    // Si se proporciona command_id, obtener memorias de búsqueda
    if (commandId) {
      console.log(`🧠 Obteniendo memorias para command_id: ${commandId}`);
      const memoriesResult = await getAgentSearchMemories(
        dataAnalystAgent.agentId, 
        timeRange, 
        memoryLimit,
        commandId
      );
      
      if (!memoriesResult.success || !memoriesResult.memories) {
        return {
          success: false,
          error: memoriesResult.error || 'Failed to fetch agent memories'
        };
      }
      
      if (memoriesResult.memories.length > 0) {
        memoriesData = memoriesResult.memories;
        consolidatedData = consolidateSearchMemories(memoriesResult.memories);
        console.log(`✅ Memorias obtenidas: ${memoriesResult.memories.length}`);
      }
    }
    
    // Si no hay memorias pero tampoco hay data, retornar error
    if (!consolidatedData && !data) {
      return {
        success: false,
        error: 'No search memories found and no data provided for analysis'
      };
    }
    
    // Crear contexto de análisis incluyendo deliverables si está presente
    let analysisContext = `Research Data Analysis Request:\n- Analysis type: ${analysisType}`;
    
    // Agregar información de memorias si están disponibles
    if (consolidatedData) {
      analysisContext += `
- Total searches analyzed: ${consolidatedData.total_searches}
- Search queries: ${consolidatedData.search_queries.join('; ')}
- Total results found: ${consolidatedData.all_results.length}
- Unique sources: ${consolidatedData.sources.length}
- Search timeframe: ${consolidatedData.search_timeframe.from} to ${consolidatedData.search_timeframe.to}`;
      
      // Agregar detalles de las memorias al contexto
      if (memoriesData && memoriesData.length > 0) {
        analysisContext += `\n\nSearch Memories Data:\n`;
        memoriesData.forEach((memory, index) => {
          const memoryData = memory.data || {};
          analysisContext += `\nMemory ${index + 1}:`;
          if (memoryData.search_query) {
            analysisContext += `\n- Query: ${memoryData.search_query}`;
          }
          if (memoryData.answer) {
            analysisContext += `\n- Answer: ${memoryData.answer}`;
          }
          if (memoryData.results && Array.isArray(memoryData.results)) {
            analysisContext += `\n- Results: ${memoryData.results.length} items`;
            memoryData.results.slice(0, 3).forEach((result: any, idx: number) => {
              analysisContext += `\n  ${idx + 1}. ${result.title || 'No title'} - ${result.content?.substring(0, 100) || 'No content'}...`;
            });
          }
        });
      }
    }
    
    // Agregar data si está disponible
    if (data) {
      try {
        const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        // Truncar datos muy largos para evitar problemas de JSON
        const truncatedData = dataStr.length > 10000 ? dataStr.substring(0, 10000) + '... [truncated]' : dataStr;
        analysisContext += `\n\nAdditional Data Provided:\n${truncatedData}`;
      } catch (error) {
        analysisContext += `\n\nAdditional Data Provided: [Data structure too complex to serialize]`;
      }
    }

    // Agregar información sobre deliverables al contexto si están presentes
    if (deliverables) {
      try {
        const deliverablesStr = JSON.stringify(deliverables);
        analysisContext += `\n\nDeliverables requested: ${deliverablesStr}`;
      } catch (error) {
        analysisContext += `\n\nDeliverables requested: [Complex structure provided]`;
      }
    }
    
    analysisContext += `\n\nPlease analyze all the available data and provide comprehensive insights and the deliverables requested.`;
    
    // Crear estructura de research_analysis simple y estática
    const researchAnalysisStructure = {
      executive_summary: 'string',
      key_findings: 'array',
      data_insights: 'array',
      trend_analysis: 'object',
      recommendations: 'array',
      methodology: 'object',
      limitations: 'array',
      conclusions: 'string',
      // Si hay deliverables, los incluimos como string para que el agente los procese
      deliverables: deliverables ? 'object' : null
    };

    // Truncar contexto si es muy largo para evitar problemas
    const maxContextLength = 50000;
    const finalContext = analysisContext.length > maxContextLength 
      ? analysisContext.substring(0, maxContextLength) + '... [context truncated due to size]'
      : analysisContext.trim();
    
    // Validar que los objetos son serializables antes de crear el comando
    console.log('🔍 Validando estructura del comando antes de crear...');
    
    try {
      // Test serialization
      JSON.stringify({
        context: finalContext,
        targets: [{
          research_analysis: researchAnalysisStructure
        }]
      });
    } catch (error) {
      console.error('❌ Error en serialización del comando:', error);
      return {
        success: false,
        error: 'Failed to serialize command structure'
      };
    }
    
    // Inicializar el sistema de comandos
    const processorInitializer = ProcessorInitializer.getInstance();
    processorInitializer.initialize();
    const commandService = processorInitializer.getCommandService();
    
    // Crear comando de análisis
    const commandData = CommandFactory.createCommand({
      task: 'analysis research data',
      userId: dataAnalystAgent.userId,
      description: `Analyze research data for ${siteId} with type: ${analysisType}`,
      agentId: dataAnalystAgent.agentId,
      site_id: siteId,
      context: finalContext,
      targets: [{
        research_analysis: researchAnalysisStructure
      }],
      tools: [],
      supervisor: [
        {
          agent_role: 'data_quality_analyst',
          status: 'not_initialized'
        }
      ],
    });
    
    console.log(`🔧 Creando comando de análisis para sitio: ${siteId}`);
    
    // Enviar comando para ejecución
    const analysisCommandId = await commandService.submitCommand(commandData);
    
    console.log(`📝 Comando de análisis creado: ${analysisCommandId}`);
    
    // Esperar a que se complete el comando
    const { command: completedAnalysisCommand, completed: analysisCompleted } = await waitForCommandCompletion(analysisCommandId, 100, 2000);
    
    if (!analysisCompleted || !completedAnalysisCommand) {
      return {
        success: false,
        error: 'Analysis command did not complete successfully'
      };
    }
    
    // Extraer resultados del análisis
    let analysisResults = null;
    
    if (completedAnalysisCommand?.results && Array.isArray(completedAnalysisCommand.results)) {
      for (const result of completedAnalysisCommand.results) {
        if (result.research_analysis) {
          analysisResults = result.research_analysis;
          break;
        }
      }
    }
    
    if (!analysisResults) {
      return {
        success: false,
        error: 'No analysis results generated'
      };
    }
    
    console.log(`✅ Análisis completado exitosamente`);
    
    // Preparar respuesta
    const responseData: any = {
      agent_id: dataAnalystAgent.agentId,
      command_id: commandId || null,
      analysis_type: analysisType,
      analysis_results: analysisResults,
      timestamp: new Date().toISOString(),
      site_id: siteId
    };
    
    // Agregar datos consolidados si están disponibles y se solicitan
    if (includeRawData && consolidatedData) {
      responseData.consolidated_data = consolidatedData;
    }
    
    // Agregar información de memorias si están disponibles
    if (memoriesData && memoriesData.length > 0) {
      responseData.memories_analyzed = memoriesData.length;
      responseData.search_queries_analyzed = consolidatedData?.search_queries || [];
      responseData.total_search_results = consolidatedData?.all_results.length || 0;
    }
    
    return {
      success: true,
      data: responseData
    };
    
  } catch (error) {
    console.error('❌ Error en executeDataAnalysis:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
} 