import { NextRequest, NextResponse } from 'next/server';
import { DuckDuckGoInstantApiService } from '@/lib/services/duckduckgo-instant-api';
import { z } from 'zod';

// Schema de validación para la request
const InstantSearchSchema = z.object({
  query: z.string().min(1).max(500),
  search_type: z.enum(['web_results', 'instant_answer']).default('web_results'),
  format: z.enum(['json', 'xml']).default('json'),
  no_html: z.boolean().default(true),
  skip_disambig: z.boolean().default(true),
  no_redirect: z.boolean().default(true)
});

interface InstantSearchRequest {
  query: string;
  search_type?: 'web_results' | 'instant_answer';
  format?: 'json' | 'xml';
  no_html?: boolean;
  skip_disambig?: boolean;
  no_redirect?: boolean;
}

interface InstantSearchResponse {
  success: boolean;
  query: string;
  search_type: string;
  results?: any[];
  instant_answer?: any;
  total_results: number;
  processing_time_ms: number;
  error?: string;
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    console.log('🚀 [DuckDuckGo Instant] Iniciando búsqueda con Instant Answer API');
    
    const body = await request.json();
    
    // Validar el cuerpo de la request
    const validationResult = InstantSearchSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('❌ [DuckDuckGo Instant] Error de validación:', validationResult.error.errors);
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
      query,
      search_type,
      format,
      no_html,
      skip_disambig,
      no_redirect
    } = validationResult.data;
    
    console.log(`🔍 [DuckDuckGo Instant] Query: ${query}`);
    console.log(`📋 [DuckDuckGo Instant] Tipo de búsqueda: ${search_type}`);
    
    const instantApiService = DuckDuckGoInstantApiService.getInstance();
    let result;
    
    // Ejecutar búsqueda según el tipo
    if (search_type === 'instant_answer') {
      console.log('💡 [DuckDuckGo Instant] Ejecutando búsqueda de respuesta instantánea');
      result = await instantApiService.searchInstantAnswer(query);
    } else {
      console.log('🔍 [DuckDuckGo Instant] Ejecutando búsqueda de resultados web');
      result = await instantApiService.searchWebResults(query);
    }
    
    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SEARCH_FAILED',
            message: result.error || 'Search operation failed'
          }
        },
        { status: 500 }
      );
    }
    
    const processingTime = Date.now() - startTime;
    
    const response: InstantSearchResponse = {
      success: true,
      query,
      search_type,
      results: result.results,
      instant_answer: search_type === 'instant_answer' ? result.data : undefined,
      total_results: result.results?.length || 0,
      processing_time_ms: processingTime
    };
    
    console.log(`✅ [DuckDuckGo Instant] Búsqueda completada en ${processingTime}ms`);
    console.log(`📊 [DuckDuckGo Instant] Resultados: ${response.total_results}`);
    
    return NextResponse.json(response);
    
  } catch (error) {
    console.error('❌ [DuckDuckGo Instant] Error en operación:', error);
    
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
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  
  if (!query) {
    return NextResponse.json({
      name: 'DuckDuckGo Instant Answer API',
      description: 'API for performing searches using DuckDuckGo Instant Answer API',
      version: '1.0.0',
      endpoints: {
        POST: '/api/duckduckgo-instant',
        GET: '/api/duckduckgo-instant?q=your_query'
      },
      search_types: {
        web_results: 'Search for web results (default)',
        instant_answer: 'Search for instant answers and definitions'
      },
      parameters: {
        query: 'Required. Search query',
        search_type: 'Optional. Type of search (web_results or instant_answer)',
        format: 'Optional. Response format (json or xml)',
        no_html: 'Optional. Exclude HTML from results',
        skip_disambig: 'Optional. Skip disambiguation',
        no_redirect: 'Optional. No redirects'
      },
      examples: {
        web_results: {
          query: 'machine learning',
          search_type: 'web_results'
        },
        instant_answer: {
          query: 'what is artificial intelligence',
          search_type: 'instant_answer'
        }
      }
    });
  }
  
  // Si se proporciona un query, ejecutar búsqueda
  try {
    console.log(`🔍 [DuckDuckGo Instant] GET request con query: ${query}`);
    
    const instantApiService = DuckDuckGoInstantApiService.getInstance();
    const result = await instantApiService.searchWebResults(query);
    
    return NextResponse.json({
      success: result.success,
      query,
      results: result.results,
      total_results: result.results?.length || 0,
      error: result.error
    });
    
  } catch (error) {
    console.error('❌ [DuckDuckGo Instant] Error en GET request:', error);
    
    return NextResponse.json(
      {
        success: false,
        error: 'Search failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

