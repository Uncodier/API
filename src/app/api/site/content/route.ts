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
  segment_id: z.string().min(1, 'El ID del segmento es requerido').optional(),
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

// Interfaz para la respuesta de contenido cuando se proporciona un segmento específico
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

// Interfaz para la respuesta de contenido cuando se analizan todos los segmentos
interface AllSegmentsContentResponse {
  url: string;
  analysis_type: "all_segments";
  segments_summary: Array<{
    segment_id: string;
    segment_name: string;
    content_count: number;
    top_themes: string[];
    engagement_level: string;
    primary_funnel_stage: string;
  }>;
  global_recommendations: Array<ContentItem>;
  total_segments_analyzed: number;
  total_content_items: number;
  metadata: {
    request: {
      timestamp: string;
      parameters: Record<string, any>;
    };
    analysis: {
      modelUsed: string;
      aiProvider: string;
      processingTime: string;
      segmentsDataSource: string;
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

// Nueva interfaz para contenido con métricas de performance
interface PerformanceContentItem extends ContentItem {
  performanceMetrics: {
    overallScore: number;
    engagementRate: number;
    conversionRate: number;
    timeOnPage: number;
    bounceRate: number;
    shareRate: number;
    commentRate: number;
    clickThroughRate: number;
    completionRate?: number; // Para videos/podcasts
    downloadRate?: number; // Para downloads
  };
  businessImpact: {
    leadGeneration: number;
    revenue: number;
    brandAwareness: number;
    customerRetention: number;
  };
  performanceRank: number;
  performanceCategory: 'top_performing' | 'poor_performing' | 'average';
  lastUpdated: string;
  trendsData: {
    viewTrend: 'increasing' | 'decreasing' | 'stable';
    engagementTrend: 'increasing' | 'decreasing' | 'stable';
    conversionTrend: 'increasing' | 'decreasing' | 'stable';
  };
}

// Interfaz para el análisis de performance de contenido
interface ContentPerformanceAnalysis {
  topPerformingContent: PerformanceContentItem[];
  poorPerformingContent: PerformanceContentItem[];
  performanceSummary: {
    totalContentAnalyzed: number;
    averageEngagementRate: number;
    averageConversionRate: number;
    topPerformingCategory: string;
    mainIssuesIdentified: string[];
    recommendedActions: string[];
  };
  segmentPerformance?: {
    segment_id: string;
    segment_name: string;
    bestPerformingTopics: string[];
    worstPerformingTopics: string[];
    optimalContentFormat: string[];
    recommendedFrequency: string;
  };
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

  // Verificar si se proporcionó un segment_id específico
  if (params.segment_id) {
    // Prompt para segmento específico
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
  "segment_id": "${params.segment_id}",
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
        "segment_id": "${params.segment_id}",
        "content_types": ["posts", "videos", "downloads"],
        "limit": 1
      }
    },
    "analysis": {
      "modelUsed": "claude-3-5-sonnet-20240620",
      "aiProvider": "anthropic",
      "processingTime": "1.32 seconds",
      "segmentDataSource": "${params.segment_id} (last updated: 2024-07-10)",
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

    console.log('[API:content] Prompt prepared for specific segment, length:', prompt.length);
    return prompt;
  } else {
    // Prompt para análisis de todos los segmentos
    let prompt = `Analiza el sitio web ${params.url} y genera un resumen de contenido personalizado para TODOS LOS SEGMENTOS DE AUDIENCIA disponibles.

Como no se especificó un segment_id, necesito que analices todos los segmentos de audiencia disponibles y generes:
1. Un resumen de cada segmento encontrado
2. ${params.limit} recomendaciones de contenido globales de los siguientes tipos: ${contentTypesStr}
3. Las recomendaciones deben ser relevantes para la etapa del funnel "${params.funnel_stage}" y focalizadas en los siguientes temas: ${topicsStr}

Tu respuesta debe ser un objeto JSON estructurado con los siguientes campos principales:
- url: URL del sitio analizado
- analysis_type: "all_segments"
- segments_summary: array de resúmenes de cada segmento encontrado
- global_recommendations: array de elementos de contenido recomendados globalmente
- total_segments_analyzed: número total de segmentos analizados
- total_content_items: número total de elementos de contenido encontrados
- metadata: metadatos de la solicitud y análisis

Cada elemento en el array "segments_summary" debe incluir:
- segment_id: ID del segmento
- segment_name: nombre descriptivo del segmento
- content_count: número de contenidos relevantes para este segmento
- top_themes: array de los principales temas de interés
- engagement_level: nivel de engagement (high, medium, low)
- primary_funnel_stage: etapa principal del funnel para este segmento

Cada elemento de contenido en el array "global_recommendations" debe incluir los mismos campos que en el análisis específico de segmento.

Por favor, sé creativo pero realista en las recomendaciones. Genera segmentos y URLs plausibles basados en la estructura del sitio ${params.url}.

Ordena los resultados según el criterio: ${params.sort_by}.

A continuación te proporciono un ejemplo de la estructura esperada para tu respuesta:

\`\`\`json
{
  "url": "https://ejemplo.com",
  "analysis_type": "all_segments",
  "segments_summary": [
    {
      "segment_id": "seg_content_creators",
      "segment_name": "Creadores de Contenido",
      "content_count": 25,
      "top_themes": ["herramientas", "productividad", "creatividad"],
      "engagement_level": "high",
      "primary_funnel_stage": "consideration"
    },
    {
      "segment_id": "seg_small_businesses",
      "segment_name": "Pequeñas Empresas",
      "content_count": 18,
      "top_themes": ["marketing", "automatización", "crecimiento"],
      "engagement_level": "medium",
      "primary_funnel_stage": "awareness"
    }
  ],
  "global_recommendations": [
    {
      "id": "post_12345",
      "type": "post",
      "title": "Guía Completa para Emprendedores Digitales",
      "description": "Estrategias y herramientas esenciales para cualquier emprendedor que quiera destacar en el mundo digital.",
      "url": "https://ejemplo.com/blog/guia-emprendedores-digitales",
      "duration": {
        "unit": "minutes",
        "value": 12
      },
      "topics": ["emprendimiento", "digital", "estrategia"],
      "funnelStage": "awareness",
      "relevanceScore": 0.88,
      "engagementPrediction": {
        "score": 0.85,
        "metrics": {
          "crossSegmentAppeal": "High",
          "shareability": "Very high",
          "conversionPotential": "Medium"
        }
      },
      "format": "guide",
      "readingLevel": "intermediate",
      "popularity": {
        "views": 15600,
        "shares": 420,
        "comments": 67
      }
    }
  ],
  "total_segments_analyzed": 2,
  "total_content_items": 43,
  "metadata": {
    "request": {
      "timestamp": "2024-07-15T16:42:18Z",
      "parameters": {
        "analysis_type": "all_segments",
        "content_types": ["posts", "videos"],
        "limit": 1
      }
    },
    "analysis": {
      "modelUsed": "claude-3-5-sonnet-20240620",
      "aiProvider": "anthropic",
      "processingTime": "2.15 seconds",
      "segmentsDataSource": "all_segments (last updated: 2024-07-10)",
      "contentInventorySize": 43,
      "filteringMetrics": [
        "Relevancia cross-segmento",
        "Engagement promedio por segmento",
        "Recencia del contenido",
        "Potencial de conversión global"
      ]
    }
  }
}
\`\`\`

IMPORTANTE: Sigue EXACTAMENTE la misma estructura del ejemplo anterior. No añadas ni omitas ningún campo.`;

    console.log('[API:content] Prompt prepared for all segments analysis, length:', prompt.length);
    return prompt;
  }
}

/**
 * Procesa la respuesta de la IA y la formatea según la estructura esperada
 */
function processAIResponse(aiResponse: any, params: z.infer<typeof RequestSchema>, startTime: number): ContentResponse | AllSegmentsContentResponse {
  console.log('[API:content] Processing AI response');
  
  // Calcular tiempo de procesamiento
  const processingTimeMs = Date.now() - startTime;
  
  // Verificar si es una respuesta de todos los segmentos
  if (aiResponse && typeof aiResponse === 'object' && aiResponse.analysis_type === "all_segments") {
    console.log('[API:content] AI response is for all segments analysis');
    
    // Asegurar que global_recommendations tenga IDs válidos
    if (Array.isArray(aiResponse.global_recommendations)) {
      aiResponse.global_recommendations = aiResponse.global_recommendations.map((rec: any) => {
        if (!rec.id) {
          rec.id = generateContentId(rec.type || 'content');
        }
        return rec;
      });
    }
    
    // Asegurar metadatos completos para análisis de todos los segmentos
    if (!aiResponse.metadata) {
      aiResponse.metadata = {};
    }
    
    if (!aiResponse.metadata.request) {
      aiResponse.metadata.request = {
        timestamp: new Date().toISOString(),
        parameters: {
          analysis_type: "all_segments",
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
        segmentsDataSource: `all_segments (last updated: ${new Date().toISOString().split('T')[0]})`,
        contentInventorySize: aiResponse.total_content_items || (aiResponse.global_recommendations?.length || 0) * 10,
        filteringMetrics: [
          "Relevancia cross-segmento",
          "Engagement promedio por segmento",
          "Recencia del contenido",
          "Potencial de conversión global"
        ]
      };
    } else {
      aiResponse.metadata.analysis.processingTime = `${processingTimeMs} ms`;
    }
    
    return aiResponse as AllSegmentsContentResponse;
  }
  // Verificar si la respuesta tiene la estructura esperada para segmento específico
  else if (aiResponse && typeof aiResponse === 'object' && Array.isArray(aiResponse.recommendations)) {
    console.log('[API:content] AI response has expected structure for specific segment');
    
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
          segment_id: params.segment_id || 'unknown',
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
        segmentDataSource: `${params.segment_id || 'unknown'} (last updated: ${new Date().toISOString().split('T')[0]})`,
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
function generateFallbackResponse(params: z.infer<typeof RequestSchema>, processingTimeMs: number): ContentResponse | AllSegmentsContentResponse {
  console.log('[API:content] Generating fallback response');
  
  // Crear recomendaciones de ejemplo basadas en los tipos de contenido solicitados
  const contentTypes = params.content_types || ['posts', 'videos'];
  
  // Si no hay segment_id, generar respuesta para todos los segmentos
  if (!params.segment_id) {
    const recommendations: ContentItem[] = [];
    
    for (let i = 0; i < Math.min(params.limit, 3); i++) {
      const type = contentTypes[i % contentTypes.length];
      
      const baseContentItem: ContentItem = {
        id: generateContentId(type),
        type: type,
        title: `Contenido global de ejemplo (${i + 1})`,
        description: `Este es un contenido de ejemplo generado como fallback para todos los segmentos.`,
        url: `${params.url}/content/${type}/${Date.now() + i}`,
        topics: ["ejemplo", "global"],
        funnelStage: params.funnel_stage === 'all' ? 'consideration' : params.funnel_stage,
        relevanceScore: 0.75,
        engagementPrediction: {
          score: 0.7,
          metrics: {
            crossSegmentAppeal: "Medium",
            shareability: "Medium"
          }
        },
        popularity: {
          views: 1000 + (i * 100),
          likes: 50 + (i * 10)
        }
      };
      
      recommendations.push(baseContentItem);
    }
    
    return {
      url: params.url,
      analysis_type: "all_segments",
      segments_summary: [
        {
          segment_id: "seg_fallback_1",
          segment_name: "Segmento de Ejemplo 1",
          content_count: 10,
          top_themes: ["ejemplo", "contenido"],
          engagement_level: "medium",
          primary_funnel_stage: "consideration"
        },
        {
          segment_id: "seg_fallback_2",
          segment_name: "Segmento de Ejemplo 2",
          content_count: 8,
          top_themes: ["fallback", "demo"],
          engagement_level: "low",
          primary_funnel_stage: "awareness"
        }
      ],
      global_recommendations: recommendations,
      total_segments_analyzed: 2,
      total_content_items: 18,
      metadata: {
        request: {
          timestamp: new Date().toISOString(),
          parameters: {
            analysis_type: "all_segments",
            content_types: params.content_types,
            limit: params.limit
          }
        },
        analysis: {
          modelUsed: params.modelId,
          aiProvider: params.provider,
          processingTime: `${processingTimeMs} ms (fallback response)`,
          segmentsDataSource: `all_segments (fallback data)`,
          contentInventorySize: 18,
          filteringMetrics: [
            "Contenido de fallback",
            "Sin filtros aplicados"
          ]
        }
      }
    } as AllSegmentsContentResponse;
  }
  
  // Si hay segment_id, generar respuesta para segmento específico
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
    segment_id: params.segment_id!,
    recommendations: recommendations,
    total_results: recommendations.length * 5,
    returned_results: recommendations.length,
    metadata: {
      request: {
        timestamp: new Date().toISOString(),
        parameters: {
          segment_id: params.segment_id!,
          content_types: params.content_types,
          limit: params.limit
        }
      },
      analysis: {
        modelUsed: params.modelId,
        aiProvider: params.provider,
        processingTime: `${processingTimeMs} ms (fallback response)`,
        segmentDataSource: `${params.segment_id!} (fallback data)`,
        contentInventorySize: recommendations.length * 5,
        filteringMetrics: [
          "Contenido de fallback",
          "Sin filtros aplicados"
        ]
      }
    }
  } as ContentResponse;
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
    
    // Verificar si hay recomendaciones según el tipo de respuesta
    const hasRecommendations = 
      ('recommendations' in contentData && contentData.recommendations.length > 0) ||
      ('global_recommendations' in contentData && contentData.global_recommendations.length > 0);
    
    if (!hasRecommendations) {
      console.warn('[API:content] No content recommendations found');
      return NextResponse.json(
        { 
          url: params.url,
          segment_id: params.segment_id || null,
          recommendations: [],
          total_results: 0,
          returned_results: 0,
          error: {
            code: 404,
            message: 'No se encontraron recomendaciones de contenido para el contexto especificado',
            details: 'Prueba con otros parámetros o modifica los filtros'
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