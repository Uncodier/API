import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { reportTool } from '@/app/api/agents/tools/report/assistantProtocol';

// Configurar timeout máximo a 5 minutos (300 segundos)
// Máximo para plan Pro de Vercel
export const maxDuration = 300;

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
    
    analysisContext += `\n\nIMPORTANT ANALYSIS INSTRUCTIONS:
1. Please analyze all the available data and provide comprehensive insights and the deliverables requested.
2. CRITICAL: Carefully examine all provided data for inconsistencies, contradictions, or conflicting information.
3. If you identify any data inconsistencies, clearly document them in your analysis and explain how they might impact the reliability of your findings.
4. Cross-reference information from different sources to validate findings and identify potential discrepancies.
5. When inconsistencies are found, provide recommendations on how to resolve them or additional data that might be needed.
6. Ensure all deliverables are based on verified, consistent data to maintain quality and accuracy.`;
    
    // Crear estructura de research_analysis simple y estática
    const researchAnalysisStructure = {
      executive_summary: 'string',
      key_findings: 'array',
      data_insights: 'array',
      trend_analysis: 'object',
      recommendations: 'array',
      methodology: 'object',
      limitations: 'array',
      data_inconsistencies: 'array', // Nuevo campo para reportar inconsistencias encontradas
      conclusions: 'string',
      // Si hay deliverables, los incluimos como string para que el agente los procese
      deliverables: deliverables ? 'object' : null
    };

    // Truncar contexto si es muy largo para evitar problemas
    const maxContextLength = 50000;
    const finalContext = analysisContext.length > maxContextLength 
      ? analysisContext.substring(0, maxContextLength) + '... [context truncated due to size]'
      : analysisContext.trim();
    
    // Prepare tools and sanitize them for serialization
    const rawTools = [
      reportTool(site_id, dataAnalystAgent.userId ?? ''),
    ];
    
    const sanitizedTools = rawTools.map(tool => {
      // Create a shallow copy and remove function properties
      const { handler, execute, ...rest } = tool;
      return rest;
    });

    // Validar que los objetos son serializables antes de crear el comando
    console.log('🔍 Validando estructura del comando antes de crear...');
    
    try {
      // Test serialization
      JSON.stringify({
        context: finalContext,
        targets: [{
          research_analysis: researchAnalysisStructure
        }],
        tools: sanitizedTools,
        supervisor: [{
          agent_role: 'research_manager',
          status: 'not_initialized'
        }]
      });
      console.log('✅ Validación de JSON exitosa');
    } catch (error) {
      console.error('❌ Error en validación de JSON:', error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'JSON_SERIALIZATION_ERROR', 
            message: 'Command data structure cannot be serialized to JSON' 
          } 
        },
        { status: 400 }
      );
    }

    const commandData = CommandFactory.createCommand({
      task: 'analyze the research data',
      userId: dataAnalystAgent.userId ?? '',
      description: `Analyze consolidated research data from ${consolidatedData ? consolidatedData.total_searches : 0} searches${data ? ' and additional data' : ''}`,
      agentId: dataAnalystAgent.agentId,
      agentRole: 'Data Analyst',
      site_id: site_id,
      context: finalContext,
      targets: [
        {
          research_analysis: researchAnalysisStructure
        }
      ],
      tools: sanitizedTools,
      supervisor: [
        {
          agent_role: 'research_manager',
          status: 'not_initialized'
        }
      ],
      model: "gpt-5-mini",
      modelType: "openai"
    });
    
    console.log(`🔧 Creando comando de análisis de investigación`);
    
    // Enviar comando para ejecución
    const internalCommandId = await commandService.submitCommand(commandData);
    
    console.log(`📝 Comando de análisis creado: ${internalCommandId}`);
    
    // Obtener el UUID real del comando buscando en la base de datos
    let realCommandId = null;
    try {
      // Buscar el comando más reciente para este agente con la misma descripción
      const { data: recentCommands, error } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('agent_id', dataAnalystAgent.agentId)
        .eq('description', `Analyze consolidated research data from ${consolidatedData ? consolidatedData.total_searches : 0} searches${data ? ' and additional data' : ''}`)
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (!error && recentCommands && recentCommands.length > 0) {
        realCommandId = recentCommands[0].id;
        console.log(`🔍 UUID real del comando encontrado: ${realCommandId}`);
      }
    } catch (error) {
      console.log('No se pudo obtener el UUID del comando desde BD, usando ID interno');
    }
    
    // Si no tenemos el UUID real, usar el ID interno
    const commandIdToSearch = realCommandId || internalCommandId;
    
    // Esperar a que el comando se complete
    let completedCommand = null;
    const maxRetries = 580; // 580 intentos = 290 segundos máximo (~4.8 minutos)
    const retryDelay = 500; // 500ms entre intentos
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Buscar comando en base de datos por ID
        const { data: commandData, error } = await supabaseAdmin
          .from('commands')
          .select('*')
          .eq('id', commandIdToSearch)
          .single();
        
        if (!error && commandData) {
          if (commandData.status === 'completed') {
            completedCommand = commandData;
            console.log(`✅ Comando completado después de ${attempt + 1} intentos`);
            break;
          } else if (commandData.status === 'failed') {
            console.error(`❌ Comando falló después de ${attempt + 1} intentos`);
            return NextResponse.json(
              { 
                success: false, 
                error: { 
                  code: 'COMMAND_EXECUTION_FAILED', 
                  message: 'Research analysis command failed to execute',
                  commandId: commandIdToSearch
                } 
              },
              { status: 500 }
            );
          }
        }
        
        // Si no está completado, esperar antes del siguiente intento
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      } catch (error) {
        console.log(`Intento ${attempt + 1}/${maxRetries}: Comando aún procesándose...`);
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    if (!completedCommand) {
      console.log('⚠️ Comando no completado después del tiempo máximo de espera');
    }
    
    // Preparar respuesta con datos consolidados
    const responseData: any = {
      commandId: commandIdToSearch,
      status: completedCommand ? 'completed' : 'timeout',
      message: completedCommand ? 'Research analysis completed' : 'Research analysis timed out - command may still be processing',
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
