import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para encontrar agente con role "Data Analyst"
async function findDataAnalystAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
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
async function getAgentSearchMemories(agentId: string, timeRange?: {from?: string, to?: string}, limit: number = 50, commandId?: string): Promise<{success: boolean, memories?: any[], error?: string}> {
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
function consolidateSearchMemories(memories: any[]): {
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

// Inicializar el sistema de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { 
      site_id, 
      agent_id,
      command_id,
      data,
      analysis_type = 'comprehensive',
      time_range,
      memory_limit = 50,
      include_raw_data = false,
      deliverables
    } = body;
    
    // Validar parámetros requeridos
    if (!site_id) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required' } },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(site_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    // Buscar agente Data Analyst
    let dataAnalystAgent = null;
    
    if (agent_id && isValidUUID(agent_id)) {
      // Si se proporciona agent_id específico, verificar que existe
      const { data, error } = await supabaseAdmin
        .from('agents')
        .select('id, user_id')
        .eq('id', agent_id)
        .single();
      
      if (!error && data) {
        dataAnalystAgent = {
          agentId: data.id,
          userId: data.user_id
        };
      }
    }
    
    if (!dataAnalystAgent) {
      dataAnalystAgent = await findDataAnalystAgent(site_id);
    }
    
    if (!dataAnalystAgent) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATA_ANALYST_NOT_FOUND', 
            message: 'No se encontró un agente con role "Data Analyst" para este sitio' 
          } 
        },
        { status: 404 }
      );
    }
    
    console.log(`📊 Iniciando análisis para agente: ${dataAnalystAgent.agentId}`);
    
    let consolidatedData = null;
    let memoriesData = null;
    
    // Si se proporciona command_id, obtener memorias de búsqueda
    if (command_id) {
      console.log(`🧠 Obteniendo memorias para command_id: ${command_id}`);
      const memoriesResult = await getAgentSearchMemories(
        dataAnalystAgent.agentId, 
        time_range, 
        memory_limit,
        command_id
      );
      
      if (!memoriesResult.success || !memoriesResult.memories) {
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'MEMORIES_FETCH_FAILED', 
              message: memoriesResult.error || 'Failed to fetch agent memories' 
            } 
          },
          { status: 500 }
        );
      }
      
      if (memoriesResult.memories.length > 0) {
        memoriesData = memoriesResult.memories;
        consolidatedData = consolidateSearchMemories(memoriesResult.memories);
        console.log(`✅ Memorias obtenidas: ${memoriesResult.memories.length}`);
      }
    }
    
    // Si no hay memorias pero tampoco hay data, retornar error
    if (!consolidatedData && !data) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'NO_DATA_PROVIDED',
          message: 'No search memories found and no data provided for analysis'
        }
      }, { status: 400 });
    }
    
    // Crear contexto de análisis incluyendo deliverables si está presente
    let analysisContext = `Research Data Analysis Request:\n- Analysis type: ${analysis_type}`;
    
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
      analysisContext += `\n\nAdditional Data Provided:\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
    }

    
    analysisContext += `\n\nPlease analyze all the available data and provide comprehensive insights.`;
    
    // Crear estructura de research_analysis dinámicamente
    const researchAnalysisStructure: any = {
      executive_summary: 'string',
      key_findings: 'array',
      data_insights: 'array',
      trend_analysis: 'object',
      recommendations: 'array',
      methodology: 'object',
      limitations: 'array',
      conclusions: 'string'
    };

    // Solo incluir deliverables si se proporciona en la request
    if (deliverables) {
      researchAnalysisStructure.deliverables = deliverables;
    }

    const commandData = CommandFactory.createCommand({
      task: 'analyze the research data',
      userId: dataAnalystAgent.userId,
      description: `Analyze ${consolidatedData ? `consolidated research data from ${consolidatedData.total_searches} searches` : 'provided data'}${data ? ' and additional data' : ''}`,
      agentId: dataAnalystAgent.agentId,
      site_id: site_id,
      context: analysisContext.trim(),
      targets: [
        {
          research_analysis: researchAnalysisStructure
        }
      ],
      tools: [
        // {
        //   name: 'data_consolidation',
        //   description: 'Consolidate and structure research findings',
        //   status: 'not_initialized',
        //   type: 'synchronous',
        //   parameters: {
        //     total_searches: consolidatedData.total_searches,
        //     findings_count: consolidatedData.consolidated_findings.length,
        //     analysis_type: analysis_type
        //   }
        // },
        // {
        //   name: 'pattern_analysis',
        //   description: 'Identify patterns and trends in the research data',
        //   status: 'not_initialized',
        //   type: 'synchronous',
        //   parameters: {
        //     queries: consolidatedData.search_queries,
        //     timeframe: consolidatedData.search_timeframe
        //   }
        // },
        // {
        //   name: 'insight_generation',
        //   description: 'Generate actionable insights from the consolidated data',
        //   status: 'not_initialized',
        //   type: 'synchronous',
        //   parameters: {
        //     source_count: consolidatedData.sources.length,
        //     analysis_depth: analysis_type
        //   }
        // }
      ],
      supervisor: [
        {
          agent_role: 'research_manager',
          status: 'not_initialized'
        }
      ],
    });
    
    console.log(`🔧 Creando comando de análisis de investigación`);
    
    // Enviar comando para ejecución
    const commandId = await commandService.submitCommand(commandData);
    
    console.log(`📝 Comando de análisis creado: ${commandId}`);
    
    // Intentar obtener el comando completado si ya existe
    let completedCommand = null;
    try {
      // Buscar comando en base de datos por ID
      const { data: commandData, error } = await supabaseAdmin
        .from('commands')
        .select('*')
        .eq('id', commandId)
        .single();
      
      if (!error && commandData && commandData.status === 'completed') {
        completedCommand = commandData;
      }
    } catch (error) {
      console.log('Comando aún no completado, retornando estado de procesamiento');
    }
    
    // Preparar respuesta con datos consolidados
    const responseData: any = {
      commandId,
      status: completedCommand ? 'completed' : 'processing',
      message: completedCommand ? 'Research analysis completed' : 'Research analysis started',
      agent_id: dataAnalystAgent.agentId,
      analysis_type: analysis_type,
      filtered_by_command_id: command_id || null,
      has_memories: !!consolidatedData,
      has_additional_data: !!data,
      timestamp: new Date().toISOString()
    };

    // Agregar datos de memorias si están disponibles
    if (consolidatedData) {
      responseData.data_summary = {
        total_memories_analyzed: consolidatedData.total_searches,
        unique_search_queries: consolidatedData.search_queries.length,
        total_results_processed: consolidatedData.all_results.length,
        unique_sources: consolidatedData.sources.length,
        search_timeframe: consolidatedData.search_timeframe
      };
      
      responseData.consolidated_search_data = {
        search_queries: consolidatedData.search_queries,
        sources: consolidatedData.sources,
        answers: consolidatedData.answers,
        total_findings: consolidatedData.consolidated_findings.length
      };
    }

    // Agregar información sobre data adicional si está presente
    if (data) {
      responseData.additional_data_info = {
        type: typeof data,
        has_content: !!data,
        length: typeof data === 'string' ? data.length : (Array.isArray(data) ? data.length : Object.keys(data || {}).length)
      };
    }

    // Si el comando está completado, extraer los resultados del análisis
    if (completedCommand && completedCommand.results) {
      try {
        const results = Array.isArray(completedCommand.results) ? completedCommand.results : [completedCommand.results];
        const resultWithResearchAnalysis = results.find((result: any) => result.research_analysis);
        
        if (resultWithResearchAnalysis) {
          // Crear una copia del research_analysis para evitar modificar el original
          const researchAnalysisCopy = { ...resultWithResearchAnalysis.research_analysis };
          
          // Si hay deliverables, copiarlos a la raíz y eliminarlos de la copia
          if (researchAnalysisCopy.deliverables) {
            responseData.deliverables = researchAnalysisCopy.deliverables;
            delete researchAnalysisCopy.deliverables;
          }
          
          // Poner el research_analysis sin deliverables en la raíz de data
          responseData.research_analysis = researchAnalysisCopy;
        }
      } catch (error) {
        console.error('Error extracting research_analysis from completed command:', error);
      }
    }
    
    // Incluir datos raw si se solicita
    if (include_raw_data) {
      responseData.raw_data = {};
      
      // Agregar datos raw de memorias si están disponibles
      if (consolidatedData) {
        responseData.raw_data.search_memories = {
          search_queries: consolidatedData.search_queries,
          consolidated_findings: consolidatedData.consolidated_findings,
          sources: consolidatedData.sources,
          answers: consolidatedData.answers
        };
      }
      
      // Agregar data adicional si está presente
      if (data) {
        responseData.raw_data.additional_data = data;
      }
    }
    
    return NextResponse.json({
      success: true,
      data: responseData
    });
    
  } catch (error) {
    console.error('❌ Error en ruta analysis:', error);
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
