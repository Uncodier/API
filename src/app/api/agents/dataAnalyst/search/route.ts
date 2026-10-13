import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CreditService } from '@/lib/services/billing/CreditService';
import { findDataAnalystAgent, saveToAgentMemory } from '@/lib/services/search/data-analyst-search';
import { getWebSearchConfig, searchWeb, validateWebSearchOptions, WebSearchError } from '@/lib/services/search/web-search';

export const maxDuration = 300;

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Extraer parámetros de diferentes estructuras posibles
    let site_id, search_queries, search_options = {}, agent_id, command_id;

    // Verificar si los datos vienen en la estructura anidada de operation
    if (body.operation && typeof body.operation === 'object') {
      site_id = body.site_id;
      search_queries = body.operation.search_queries;
      search_options = body.operation.search_options || {};
      agent_id = body.agent_id;
      command_id = body.command_id;
    } else {
      // Estructura plana tradicional
      site_id = body.site_id;
      search_queries = body.search_queries;
      search_options = body.search_options || {};
      agent_id = body.agent_id;
      command_id = body.command_id;
    }



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

    if (!search_queries || !Array.isArray(search_queries) || search_queries.length === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'search_queries must be a non-empty array' } },
        { status: 400 }
      );
    }

    // Validate unsupported options before charging or sending a provider request.
    try {
      search_options = validateWebSearchOptions(search_options);
      if (search_queries.some((query: unknown) => typeof query !== 'string' || !query.trim() || query.length > 8000)) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_REQUEST', message: 'search_queries must contain nonempty strings of at most 8000 characters' } },
          { status: 400 }
        );
      }
    } catch (error) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: error instanceof WebSearchError ? error.message : 'Invalid search options' } },
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

    try {
      getWebSearchConfig();
    } catch (error) {
      return NextResponse.json(
        { success: false, error: { code: 'SEARCH_NOT_CONFIGURED', message: error instanceof WebSearchError ? error.message : 'Azure web search is not configured' } },
        { status: 503 }
      );
    }

    // Validate and deduct credits for web search
    try {
      const requiredCredits = CreditService.PRICING.WEB_SEARCH * search_queries.length;
      const hasCredits = await CreditService.validateCredits(site_id, requiredCredits);
      if (!hasCredits) {
        return NextResponse.json(
          { success: false, error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credits for web search' } },
          { status: 402 }
        );
      }

      const deduction = await CreditService.deductCredits(
        site_id,
        requiredCredits,
        'web_search',
        `Web search (${search_queries.length} queries)`,
        { queries: search_queries.length, agent_id, provider: 'azure_bing' }
      );
      if (!deduction.success) throw new Error(deduction.error || 'Credit deduction failed');
    } catch (error: any) {
      return NextResponse.json(
        { success: false, error: { code: 'CREDIT_DEDUCTION_FAILED', message: error.message } },
        { status: 402 }
      );
    }

    console.log(`🔍 Iniciando búsquedas para ${search_queries.length} consultas`);

    const searchResults = [];
    const memoryIds = [];

    // Realizar búsquedas secuencialmente para evitar rate limiting
    for (const query of search_queries) {
      if (typeof query !== 'string' || query.trim().length === 0) {
        console.warn(`⚠️ Saltando consulta inválida: ${query}`);
        continue;
      }

      console.log(`🔍 Procesando consulta: "${query}"`);

      // Realizar búsqueda con Azure Bing
      const searchResult = await searchWeb(query.trim(), search_options);

      if (searchResult.success) {
        // Guardar en agent_memories
        const memoryResult = await saveToAgentMemory(
          dataAnalystAgent.agentId,
          dataAnalystAgent.userId,
          query.trim(),
          searchResult.data,
          command_id
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
      if (search_queries.indexOf(query) < search_queries.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const successfulSearches = searchResults.filter(r => r.success).length;
    const failedSearches = searchResults.filter(r => !r.success).length;

    console.log(`✅ Búsquedas completadas: ${successfulSearches} exitosas, ${failedSearches} fallidas`);

    return NextResponse.json({
      success: true,
      data: {
        agent_id: dataAnalystAgent.agentId,
        command_id: command_id || null,
        total_queries: search_queries.length,
        successful_searches: successfulSearches,
        failed_searches: failedSearches,
        search_results: searchResults,
        memory_ids: memoryIds,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Error en ruta search:', error);
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
