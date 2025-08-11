import { NextRequest, NextResponse } from 'next/server';
import { GoogleSearchService } from '@/lib/services/google-search-service';
import { searchWithTavily } from '@/lib/services/search/data-analyst-search';
import { z } from 'zod';

// Schema de validación para la request
const DeepResearchOperationSchema = z.object({
  operation_type: z.enum(['llm_news', 'general_news', 'custom_search']),
  query: z.string().min(1).max(500).optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD
  sources: z.array(z.string()).optional(), // ["news.ycombinator.com", "techcrunch.com"]
  keywords: z.array(z.string()).optional(), // ["ChatGPT", "OpenAI", "anthropic"]
  max_results: z.number().min(1).max(100).default(30)
  // Análisis de contenido removido para simplificar
});

interface ProcessedResult {
  title: string;
  url: string;
  domain: string;
  publishedDate?: string;
  // Simplificado: solo URLs y metadatos básicos
}

interface OperationResponse {
  success: boolean;
  operation_type: string;
  query: string;
  date_range: {
    from?: string;
    to?: string;
  };
  results: ProcessedResult[];
  total_results: number;
  processing_time_ms: number;
  error?: string;
  // analysis_included removido
}

// Análisis de contenido removido - solo extraemos URLs

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    console.log('🚀 [DeepResearch] Iniciando operación de investigación');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = DeepResearchOperationSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [DeepResearch] Error de validación:', validationResult.error.errors);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: validationResult.error.errors
          }
        },
        { status: 400 }
      );
    }
    
    const {
      operation_type,
      query,
      date_from,
      date_to,
      sources,
      keywords,
      max_results
    } = validationResult.data;
    
    console.log(`📋 [DeepResearch] Tipo de operación: ${operation_type}`);
    console.log(`🔍 [DeepResearch] Query: ${query || 'N/A'}`);
    console.log(`📅 [DeepResearch] Rango de fechas: ${date_from || 'N/A'} - ${date_to || 'N/A'}`);
    
    const googleSearchService = GoogleSearchService.getInstance();
    let searchResults;
    let finalQuery = '';
    
    // Ejecutar búsqueda según el tipo de operación
    switch (operation_type) {
      case 'llm_news':
        console.log('🤖 [DeepResearch] Ejecutando búsqueda de noticias de LLMs con Google');
        searchResults = await googleSearchService.searchLLMNews({
          dateFrom: date_from,
          dateTo: date_to,
          maxResults: max_results,
          keywords
        });
        finalQuery = 'LLM and AI news';
        break;
        
      case 'general_news':
        if (!query) {
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'MISSING_QUERY',
                message: 'Query is required for general_news operation'
              }
            },
            { status: 400 }
          );
        }
        console.log('📰 [DeepResearch] Ejecutando búsqueda general de noticias con Google');
        searchResults = await googleSearchService.searchNews({
          topic: query,
          dateFrom: date_from,
          dateTo: date_to,
          sources,
          maxResults: max_results
        });
        finalQuery = query;
        break;
        
      case 'custom_search':
        if (!query) {
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'MISSING_QUERY',
                message: 'Query is required for custom_search operation'
              }
            },
            { status: 400 }
          );
        }
        console.log('🔧 [DeepResearch] Ejecutando búsqueda personalizada con Google');
        searchResults = await googleSearchService.search({
          query,
          site: sources?.[0], // Usar el primer source como sitio principal
          dateFrom: date_from,
          dateTo: date_to,
          maxResults: max_results
        });
        finalQuery = query;
        break;
        
      default:
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'INVALID_OPERATION',
              message: 'Invalid operation type'
            }
          },
          { status: 400 }
        );
    }
    
    if (!searchResults.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SEARCH_FAILED',
            message: searchResults.error || 'Search operation failed'
          }
        },
        { status: 500 }
      );
    }
    
    console.log(`✅ [DeepResearch] Búsqueda completada. ${searchResults.results.length} resultados encontrados`);
    
    // Procesar resultados (simplificado - solo URLs y metadatos)
    const processedResults: ProcessedResult[] = searchResults.results.map(result => ({
      title: result.title,
      url: result.url,
      domain: result.domain,
      publishedDate: result.publishedDate
    }));
    
    console.log(`✅ [DeepResearch] ${processedResults.length} URLs extraídas exitosamente`);
    
    const processingTime = Date.now() - startTime;
    
    const response: OperationResponse = {
      success: true,
      operation_type,
      query: finalQuery,
      date_range: {
        from: date_from,
        to: date_to
      },
      results: processedResults,
      total_results: processedResults.length,
      processing_time_ms: processingTime
    };
    
    console.log(`🎉 [DeepResearch] Operación completada en ${processingTime}ms`);
    
    return NextResponse.json(response);
    
  } catch (error) {
    console.error('❌ [DeepResearch] Error en operación:', error);
    
    const processingTime = Date.now() - startTime;
    
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'SYSTEM_ERROR',
          message: 'An internal system error occurred',
          details: error instanceof Error ? error.message : 'Unknown error'
        },
        processing_time_ms: processingTime
      },
      { status: 500 }
    );
  }
}

// Método GET para documentación y pruebas
export async function GET(request: NextRequest) {
  return NextResponse.json({
    name: 'Deep Research Operation API',
    description: 'API for performing research operations with DuckDuckGo search and optional Tavily content analysis',
    version: '1.0.0',
    endpoints: {
      POST: '/api/deepResearch/operation'
    },
    operation_types: {
      llm_news: 'Search for LLM and AI related news from Hacker News',
      general_news: 'Search for general news with custom topics',
      custom_search: 'Perform custom searches with full control'
    },
    parameters: {
      operation_type: 'Required. Type of operation to perform',
      query: 'Optional for llm_news, required for general_news and custom_search',
      date_from: 'Optional. Start date in YYYY-MM-DD format',
      date_to: 'Optional. End date in YYYY-MM-DD format',
      sources: 'Optional. Array of domains to search in',
      keywords: 'Optional. Additional keywords for LLM news search',
      max_results: 'Optional. Maximum number of results (1-100, default: 30)'
    },
    examples: {
      llm_news: {
        operation_type: 'llm_news',
        date_from: '2024-01-01',
        date_to: '2024-12-31',
        keywords: ['ChatGPT', 'Claude', 'OpenAI'],
        max_results: 50
      },
      general_news: {
        operation_type: 'general_news',
        query: 'artificial intelligence startups',
        date_from: '2024-06-01',
        date_to: '2024-12-31',
        sources: ['techcrunch.com', 'venturebeat.com']
      }
    }
  });
}
