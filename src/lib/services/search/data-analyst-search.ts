import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { searchWeb } from './web-search';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export { searchWeb } from './web-search';

// Función para guardar en agent_memories
export async function saveToAgentMemory(agentId: string, userId: string, searchQuery: string, searchResults: any, commandId?: string): Promise<{success: boolean, memoryId?: string, error?: string}> {
  try {
    const memoryId = uuidv4();
    const memoryKey = `search_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // Validar que command_id sea un UUID válido antes de guardarlo en la base de datos
    const validCommandId = commandId && isValidUUID(commandId) ? commandId : null;
    
    // Log para debug
    if (commandId && !validCommandId) {
      console.log(`⚠️ command_id '${commandId}' no es un UUID válido, no se guardará en la columna command_id de la tabla`);
    }
    
    const memoryData = {
      id: memoryId,
      agent_id: agentId,
      user_id: userId,
      command_id: validCommandId, // Solo usar UUID válido o null
      type: 'search_results',
      key: memoryKey,
      data: {
        search_query: searchQuery,
        search_timestamp: new Date().toISOString(),
        results: searchResults.results || [],
        answer: searchResults.answer || null,
        query_id: searchResults.query_id || null,
        response_time: searchResults.response_time || null,
        total_results: searchResults.results?.length || 0,
        original_command_id: commandId || null, // Mantener el ID original en data para referencia
        search_metadata: {
          search_depth: searchResults.search_depth,
          follow_up_questions: searchResults.follow_up_questions || [],
          images: searchResults.images || [],
          provider: searchResults.provider,
          citations: searchResults.citations || [],
          sources: searchResults.sources || [],
          usage: searchResults.usage,
          tool_usage: searchResults.tool_usage
        }
      },
      raw_data: JSON.stringify(searchResults),
      metadata: {
        source: 'web_search',
        search_engine: searchResults.provider || 'azure_bing',
        relevance: 'high',
        search_type: 'web_search',
        original_command_id: commandId || null // También mantener el ID original en metadata
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      access_count: 0,
      last_accessed: new Date().toISOString()
    };

    console.log(`💾 Guardando resultados de búsqueda en agent_memories para agente: ${agentId}${commandId ? ` (original_command_id: ${commandId}${validCommandId ? `, db_command_id: ${validCommandId}` : ', db_command_id: null'})` : ''}`);

    const { data, error } = await supabaseAdmin
      .from('agent_memories')
      .insert([memoryData])
      .select('id')
      .single();

    if (error) {
      console.error('❌ Error guardando en agent_memories:', error);
      return {
        success: false,
        error: error.message
      };
    }

    console.log(`✅ Memoria guardada con ID: ${data.id}`);
    
    return {
      success: true,
      memoryId: data.id
    };

  } catch (error) {
    console.error('❌ Error en saveToAgentMemory:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
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

// Función principal para ejecutar búsquedas múltiples
export async function executeMultipleSearches(
  siteId: string,
  searchQueries: string[],
  searchOptions: any = {},
  agentId?: string,
  commandId?: string
): Promise<{success: boolean, data?: any, error?: string}> {
  try {
    // Validar parámetros
    if (!siteId || !isValidUUID(siteId)) {
      return {
        success: false,
        error: 'site_id must be a valid UUID'
      };
    }
    
    if (!searchQueries || !Array.isArray(searchQueries) || searchQueries.length === 0) {
      return {
        success: false,
        error: 'search_queries must be a non-empty array'
      };
    }
    
    // Buscar agente Data Analyst
    let dataAnalystAgent = null;
    
    if (agentId && isValidUUID(agentId)) {
      // Si se proporciona agent_id específico, verificar que existe
      const { data, error } = await supabaseAdmin
        .from('agents')
        .select('id, user_id')
        .eq('id', agentId)
        .single();
      
      if (!error && data) {
        dataAnalystAgent = {
          agentId: data.id,
          userId: data.user_id
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
    
    console.log(`🔍 Iniciando búsquedas para ${searchQueries.length} consultas`);
    
    const searchResults = [];
    const memoryIds = [];
    
    // Realizar búsquedas secuencialmente para evitar rate limiting
    for (const query of searchQueries) {
      if (typeof query !== 'string' || query.trim().length === 0) {
        console.warn(`⚠️ Saltando consulta inválida: ${query}`);
        continue;
      }
      
      console.log(`🔍 Procesando consulta: "${query}"`);
      
      // Realizar búsqueda con Azure Bing
      const searchResult = await searchWeb(query.trim(), searchOptions);
      
      if (searchResult.success) {
        // Guardar en agent_memories
        const memoryResult = await saveToAgentMemory(
          dataAnalystAgent.agentId,
          dataAnalystAgent.userId,
          query.trim(),
          searchResult.data,
          commandId
        );
        
        if (memoryResult.success) {
          memoryIds.push(memoryResult.memoryId);
          searchResults.push({
            query: query.trim(),
            success: true,
            results_count: searchResult.data.results?.length || 0,
            answer: searchResult.data.answer || null,
            citations: searchResult.data.citations,
            sources: searchResult.data.sources,
            usage: searchResult.data.usage,
            tool_usage: searchResult.data.tool_usage,
            memory_id: memoryResult.memoryId
          });
        } else {
          searchResults.push({
            query: query.trim(),
            success: false,
            error: `Failed to save to memory: ${memoryResult.error}`
          });
        }
      } else {
        searchResults.push({
          query: query.trim(),
          success: false,
          error: searchResult.error
        });
      }
      
      // Pequeña pausa entre búsquedas para respetar rate limits
      if (searchQueries.indexOf(query) < searchQueries.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    const successfulSearches = searchResults.filter(r => r.success).length;
    const failedSearches = searchResults.filter(r => !r.success).length;
    
    console.log(`✅ Búsquedas completadas: ${successfulSearches} exitosas, ${failedSearches} fallidas`);
    
    return {
      success: true,
      data: {
        agent_id: dataAnalystAgent.agentId,
        command_id: commandId || null,
        total_queries: searchQueries.length,
        successful_searches: successfulSearches,
        failed_searches: failedSearches,
        search_results: searchResults,
        memory_ids: memoryIds,
        timestamp: new Date().toISOString()
      }
    };
    
  } catch (error) {
    console.error('❌ Error en executeMultipleSearches:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
} 