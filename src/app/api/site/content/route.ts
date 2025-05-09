import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { analyzeWithConversationApi } from '@/lib/services/conversation-client'

/**
 * API DE CONTENIDO PARA SEGMENTOS
 * 
 * Esta API permite obtener un conjunto de recomendaciones de contenido personalizado 
 * (posts, videos, anuncios, etc.) basado en segmentos de audiencia específicos.
 * Es útil para personalizar la experiencia de usuario y maximizar el engagement 
 * con diferentes tipos de audiencias.
 * 
 * Características principales:
 * - Recomendaciones de contenido personalizadas basadas en segmentos de audiencia
 * - Soporte para múltiples tipos de contenido (artículos, videos, podcasts, anuncios)
 * - Filtrado por temática, formato, duración y otros atributos
 * - Puntuaciones de relevancia y predicción de engagement
 * - Personalización basada en diferentes métricas (interés, etapa del funnel, intención)
 * - Soporte para diferentes modelos de IA para la generación de recomendaciones
 * - Integración con sistemas de gestión de contenidos (CMS)
 * 
 * Documentación completa: /docs/api/analysis/segments/content
 */

// Enumeraciones para tipos de datos
const ContentTypes = [
  'posts',
  'videos',
  'podcasts',
  'ads',
  'social',
  'downloads'
] as const;

const FunnelStages = [
  'all',
  'awareness',
  'consideration',
  'decision',
  'retention'
] as const;

const SortOptions = [
  'relevance',
  'date',
  'popularity'
] as const;

const AiProviders = [
  'openai',
  'anthropic',
  'gemini'
] as const;

// Esquema para validar el cuerpo de la solicitud
const RequestSchema = z.object({
  // Parámetros básicos
  url: z.string().url('Debe ser una URL válida'),
  segment_id: z.string().min(1, 'El ID del segmento es requerido'),
  content_types: z.array(z.enum(ContentTypes)).optional().default(["posts", "videos"]),
  
  // Parámetros de configuración
  limit: z.number().int().min(1).max(50).optional().default(10),
  funnel_stage: z.enum(FunnelStages).optional().default('all'),
  timeout: z.number().int().min(5000).max(120000).optional().default(30000),
  include_metadata: z.boolean().optional().default(true),
  sort_by: z.enum(SortOptions).optional().default('relevance'),
  
  // Parámetros de configuración de IA
  provider: z.enum(AiProviders).optional().default('anthropic'),
  modelId: z.string().optional().default('claude-3-5-sonnet-20240620'),
  
  // Parámetros adicionales
  user_id: z.string().optional(),
  site_id: z.string().optional(),
  includeScreenshot: z.boolean().optional().default(true),
  topics: z.array(z.string()).optional().default([]),
  debug: z.boolean().optional().default(false)
});

// Interfaz para la respuesta de contenido
interface ContentResponse {
  url: string;
  segment_id: string;
  recommendations: Array<ContentItem>;
  total_results: number;
  returned_results: number;
  metadata: {
    request: {
      timestamp: string;
      parameters: Record<string, any>;
    };
    analysis: {
      modelUsed: string;
      aiProvider: string;
      processingTime: string;
      segmentDataSource: string;
      contentInventorySize: number;
      filteringMetrics: string[];
    };
  };
}

// Interfaces para los tipos de contenido
interface ContentItem {
  id: string;
  type: string;
  title: string;
  description: string;
  url: string;
  duration?: {
    unit: string;
    value: number;
  };
  topics: string[];
  funnelStage: string;
  relevanceScore: number;
  engagementPrediction: {
    score: number;
    metrics: Record<string, string>;
  };
  format?: string;
  readingLevel?: string;
  difficultyLevel?: string;
  popularity?: Record<string, any>;
  fileType?: string;
  fileSize?: string;
  subscriptionRequired?: boolean;
}

/**
 * Genera un ID único para un elemento de contenido
 */
function generateContentId(type: string): string {
  return `${type}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
}

/**
 * Prepara el prompt para el análisis de contenido basado en segmentos
 */
function prepareContentAnalysisPrompt(params: z.infer<typeof RequestSchema>): string {
  console.log('[API:content] Preparing content analysis prompt');

  // Formatear los tipos de contenido para el prompt
  const contentTypesStr = params.content_types 
    ? params.content_types.join(', ') 
    : 'todos los tipos disponibles';

  // Formatear los temas para el prompt
  const topicsStr = params.topics && params.topics.length > 0
    ? params.topics.join(', ')
    : 'cualquier tema relevante';

  // Construir el prompt base
  let prompt = `Analiza el sitio web ${params.url} y genera recomendaciones de contenido personalizadas para el segmento de audiencia con ID "${params.segment_id}".

Necesito obtener ${params.limit} recomendaciones de contenido de los siguientes tipos: ${contentTypesStr}.
Estas recomendaciones deben ser relevantes para la etapa del funnel "${params.funnel_stage}" y focalizadas en los siguientes temas: ${topicsStr}.

Tu respuesta debe ser un objeto JSON estructurado con los siguientes campos principales:
- url: URL del sitio analizado
- segment_id: ID del segmento analizado
- recommendations: array de elementos de contenido recomendados
- total_results: número total de resultados encontrados
- returned_results: número de resultados devueltos (limitado por el parámetro limit)
- metadata: metadatos de la solicitud y análisis

Cada elemento de contenido en el array "recommendations" debe incluir:
- id: identificador único para el contenido
- type: tipo de contenido (post, video, podcast, ad, social, download)
- title: título del contenido
- description: descripción o resumen del contenido
- url: URL completa al contenido
- duration: objeto con unidad (seconds, minutes) y valor numérico (si aplica)
- topics: array de temas relacionados con el contenido
- funnelStage: etapa del embudo para la que es más relevante
- relevanceScore: puntuación de relevancia (0.0-1.0) para este segmento
- engagementPrediction: predicción de engagement con score y métricas específicas
- format: formato específico del contenido
- popularity: métricas de popularidad como vistas, likes, etc.

Por favor, sé creativo pero realista en las recomendaciones. Genera URLs y recursos plausibles basados en la estructura del sitio ${params.url}.

Ordena los resultados según el criterio: ${params.sort_by}.

A continuación te proporciono un ejemplo de la estructura esperada para tu respuesta:

\`\`\`json
{
  "url": "https://ejemplo.com",
  "segment_id": "seg_content_creators",
  "recommendations": [
    {
      "id": "post_12345",
      "type": "post",
      "title": "10 Herramientas Esenciales para Creadores de Contenido en 2024",
      "description": "Descubre las mejores herramientas que todo creador de contenido debería conocer para optimizar su flujo de trabajo y mejorar la calidad de sus producciones.",
      "url": "https://ejemplo.com/blog/herramientas-creadores-contenido-2024",
      "duration": {
        "unit": "minutes",
        "value": 8
      },
      "topics": [
        "herramientas digitales",
        "productividad",
        "creación de contenido"
      ],
      "funnelStage": "consideration",
      "relevanceScore": 0.95,
      "engagementPrediction": {
        "score": 0.89,
        "metrics": {
          "timeOnPage": "High",
          "clickProbability": "Very high",
          "conversionPotential": "Medium-high"
        }
      },
      "format": "longform",
      "readingLevel": "intermediate",
      "popularity": {
        "views": 12560,
        "shares": 342,
        "comments": 48
      }
    }
  ],
  "total_results": 87,
  "returned_results": 1,
  "metadata": {
    "request": {
      "timestamp": "2024-07-15T16:42:18Z",
      "parameters": {
        "segment_id": "seg_content_creators",
        "content_types": ["posts", "videos", "downloads"],
        "limit": 1
      }
    },
    "analysis": {
      "modelUsed": "claude-3-5-sonnet-20240620",
      "aiProvider": "anthropic",
      "processingTime": "1.32 seconds",
      "segmentDataSource": "seg_content_creators (last updated: 2024-07-10)",
      "contentInventorySize": 412,
      "filteringMetrics": [
        "Relevancia temática",
        "Historial de engagement del segmento",
        "Recencia del contenido",
        "Alineación con intereses declarados"
      ]
    }
  }
}
\`\`\`

IMPORTANTE: Sigue EXACTAMENTE la misma estructura del ejemplo anterior. No añadas ni omitas ningún campo.`;

  console.log('[API:content] Prompt prepared, length:', prompt.length);
  return prompt;
}

/**
 * Procesa la respuesta de la IA y la formatea según la estructura esperada
 */
function processAIResponse(aiResponse: any, params: z.infer<typeof RequestSchema>, startTime: number): ContentResponse {
  console.log('[API:content] Processing AI response');
  
  // Calcular tiempo de procesamiento
  const processingTimeMs = Date.now() - startTime;
  
  // Verificar si la respuesta tiene la estructura esperada
  if (aiResponse && typeof aiResponse === 'object' && Array.isArray(aiResponse.recommendations)) {
    console.log('[API:content] AI response has expected structure');
    
    // Asegurarse de que cada recomendación tenga un ID válido
    aiResponse.recommendations = aiResponse.recommendations.map((rec: any) => {
      if (!rec.id) {
        rec.id = generateContentId(rec.type || 'content');
      }
      return rec;
    });
    
    // Asegurarse de que los metadatos estén completos
    if (!aiResponse.metadata) {
      aiResponse.metadata = {};
    }
    
    if (!aiResponse.metadata.request) {
      aiResponse.metadata.request = {
        timestamp: new Date().toISOString(),
        parameters: {
          segment_id: params.segment_id,
          content_types: params.content_types,
          limit: params.limit
        }
      };
    }
    
    if (!aiResponse.metadata.analysis) {
      aiResponse.metadata.analysis = {
        modelUsed: params.modelId,
        aiProvider: params.provider,
        processingTime: `${processingTimeMs} ms`,
        segmentDataSource: `${params.segment_id} (last updated: ${new Date().toISOString().split('T')[0]})`,
        contentInventorySize: aiResponse.total_results || aiResponse.recommendations.length * 10,
        filteringMetrics: [
          "Relevancia temática",
          "Historial de engagement del segmento",
          "Recencia del contenido",
          "Alineación con intereses declarados"
        ]
      };
    } else {
      // Actualizar el tiempo de procesamiento en los metadatos
      aiResponse.metadata.analysis.processingTime = `${processingTimeMs} ms`;
    }
    
    // Asegurarse de que total_results y returned_results sean consistentes
    if (!aiResponse.total_results) {
      aiResponse.total_results = aiResponse.recommendations.length * 10; // Estimación
    }
    
    aiResponse.returned_results = aiResponse.recommendations.length;
    
    return aiResponse as ContentResponse;
  }
  
  // Si la respuesta no tiene la estructura esperada, crear una respuesta de fallback
  console.log('[API:content] AI response does not have expected structure, using fallback');
  return generateFallbackResponse(params, processingTimeMs);
}

/**
 * Genera una respuesta de fallback en caso de que la IA no devuelva una estructura válida
 */
function generateFallbackResponse(params: z.infer<typeof RequestSchema>, processingTimeMs: number): ContentResponse {
  console.log('[API:content] Generating fallback response');
  
  // Crear recomendaciones de ejemplo basadas en los tipos de contenido solicitados
  const contentTypes = params.content_types || ['posts', 'videos'];
  const recommendations: ContentItem[] = [];
  
  for (let i = 0; i < Math.min(params.limit, 5); i++) {
    // Alternar entre los tipos de contenido disponibles
    const type = contentTypes[i % contentTypes.length];
    
    const baseContentItem: ContentItem = {
      id: generateContentId(type),
      type: type,
      title: `Contenido de ejemplo para ${params.segment_id} (${i + 1})`,
      description: `Este es un contenido de ejemplo generado como fallback para el segmento ${params.segment_id}.`,
      url: `${params.url}/content/${type}/${Date.now() + i}`,
      topics: ["ejemplo", params.segment_id],
      funnelStage: params.funnel_stage === 'all' ? 'consideration' : params.funnel_stage,
      relevanceScore: 0.75,
      engagementPrediction: {
        score: 0.7,
        metrics: {
          engagement: "Medium",
          conversion: "Medium"
        }
      },
      popularity: {
        views: 1000 + (i * 100),
        likes: 50 + (i * 10)
      }
    };
    
    // Personalizar atributos según el tipo de contenido
    switch (type) {
      case 'posts':
        baseContentItem.format = 'article';
        baseContentItem.readingLevel = 'intermediate';
        baseContentItem.duration = { unit: 'minutes', value: 5 + i };
        break;
      case 'videos':
        baseContentItem.format = 'tutorial';
        baseContentItem.difficultyLevel = 'beginner';
        baseContentItem.duration = { unit: 'minutes', value: 3 + (i * 2) };
        break;
      case 'podcasts':
        baseContentItem.format = 'interview';
        baseContentItem.duration = { unit: 'minutes', value: 20 + (i * 5) };
        break;
      case 'downloads':
        baseContentItem.format = 'guide';
        baseContentItem.fileType = 'PDF';
        baseContentItem.fileSize = `${0.5 + (i * 0.2)} MB`;
        break;
    }
    
    recommendations.push(baseContentItem);
  }
  
  return {
    url: params.url,
    segment_id: params.segment_id,
    recommendations: recommendations,
    total_results: recommendations.length * 5,
    returned_results: recommendations.length,
    metadata: {
      request: {
        timestamp: new Date().toISOString(),
        parameters: {
          segment_id: params.segment_id,
          content_types: params.content_types,
          limit: params.limit
        }
      },
      analysis: {
        modelUsed: params.modelId,
        aiProvider: params.provider,
        processingTime: `${processingTimeMs} ms (fallback response)`,
        segmentDataSource: `${params.segment_id} (fallback data)`,
        contentInventorySize: recommendations.length * 5,
        filteringMetrics: [
          "Contenido de fallback",
          "Sin filtros aplicados"
        ]
      }
    }
  };
}

/**
 * POST /api/site/content
 * 
 * Endpoint para obtener recomendaciones de contenido personalizadas para un segmento específico.
 */
export async function POST(request: NextRequest) {
  console.log('[API:content] POST request received');
  
  try {
    // Validar el cuerpo de la solicitud
    console.log('[API:content] Parsing request body');
    const body = await request.json();
    console.log('[API:content] Request body parsed:', JSON.stringify(body).substring(0, 200) + '...');
    
    const validationResult = RequestSchema.safeParse(body);
    console.log('[API:content] Validation result success:', validationResult.success);
    
    if (!validationResult.success) {
      console.log('[API:content] Validation failed:', JSON.stringify(validationResult.error.format()));
      return NextResponse.json(
        { 
          error: 'Parámetros inválidos', 
          details: validationResult.error.format() 
        },
        { status: 400 }
      );
    }

    const params = validationResult.data;
    console.log('[API:content] Validated params:', JSON.stringify(params));
    
    // Iniciar timestamp para tracking de tiempo
    const startTime = Date.now();
    console.log('[API:content] Analysis started at:', new Date(startTime).toISOString());
    
    // Preparar el prompt para el análisis
    const prompt = prepareContentAnalysisPrompt(params);
    
    // Llamar a la API de conversación para obtener el análisis
    console.log('[API:content] Calling conversation API with model:', params.modelId);
    
    let aiResponse;
    try {
      console.log('[API:content] Initiating request to conversation API...');
      aiResponse = await analyzeWithConversationApi(
        prompt,
        params.provider,
        params.modelId,
        params.url,
        params.includeScreenshot,
        params.timeout,
        params.debug,
        true // toJSON: true para asegurar que la respuesta sea JSON
      );
      console.log('[API:content] Received response from conversation API');
      
      // Verificar si la respuesta tiene metadatos
      if (aiResponse && typeof aiResponse === 'object' && aiResponse._requestMetadata) {
        console.log('[API:content] Response contains metadata:', 
          JSON.stringify({
            conversationId: aiResponse._requestMetadata.conversationId,
            duration: aiResponse._requestMetadata.duration
          }));
      }
    } catch (conversationError: any) {
      console.error('[API:content] Error in conversation API:', conversationError);
      
      // Crear una respuesta de error estructurada
      return NextResponse.json(
        { 
          success: false,
          error: {
            code: 500,
            message: 'Error en la API de conversación',
            details: conversationError.message
          }
        },
        { status: 500 }
      );
    }
    
    // Procesar la respuesta de la IA
    console.log('[API:content] Processing AI response');
    const contentData = processAIResponse(aiResponse, params, startTime);
    console.log('[API:content] AI response processed');
    
    // Calcular tiempo de procesamiento real
    const processingTimeMs = Date.now() - startTime;
    if (contentData.metadata && contentData.metadata.analysis) {
      contentData.metadata.analysis.processingTime = `${processingTimeMs} ms`;
    }
    console.log('[API:content] Analysis completed in', processingTimeMs, 'ms');
    
    // Verificar si hay recomendaciones
    if (contentData.recommendations.length === 0) {
      console.warn('[API:content] No content recommendations found');
      return NextResponse.json(
        { 
          url: params.url,
          segment_id: params.segment_id,
          recommendations: [],
          total_results: 0,
          returned_results: 0,
          error: {
            code: 404,
            message: 'No se encontraron recomendaciones de contenido para el segmento especificado',
            details: 'Prueba con otro segmento o modifica los filtros'
          }
        },
        { status: 404 }
      );
    }
    
    console.log('[API:content] Returning response with status 200');
    return NextResponse.json(contentData, { status: 200 });
    
  } catch (error: any) {
    console.error('[API:content] Unexpected error:', error);
    
    return NextResponse.json(
      { 
        success: false,
        error: {
          code: 500,
          message: 'Error interno del servidor',
          details: error.message
        }
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/site/content
 * 
 * Obtiene información sobre el servicio de recomendaciones de contenido.
 */
export async function GET(request: NextRequest) {
  console.log('[API:content] GET request received');
  
  const serviceInfo = {
    service: "API de Contenido para Segmentos",
    version: "1.0.0",
    status: "operational",
    capabilities: [
      "content-recommendations",
      "segment-based-personalization",
      "funnel-stage-filtering",
      "multi-content-type-support",
      "engagement-prediction"
    ],
    supportedContentTypes: ContentTypes,
    supportedFunnelStages: FunnelStages,
    supportedSortOptions: SortOptions,
    supportedAiProviders: AiProviders,
    limits: {
      maxRecommendationsPerRequest: 50,
      requestsPerDay: 100,
      maxTimeout: 120000
    }
  };
  
  console.log('[API:content] Returning service info with status 200');
  return NextResponse.json(serviceInfo, { status: 200 });
} 