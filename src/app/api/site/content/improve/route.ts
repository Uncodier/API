import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { analyzeWithConversationApi } from '@/lib/services/conversation-client'
import { supabaseAdmin } from '@/lib/database/supabase-client'

/**
 * API DE MEJORA DE CONTENIDO EXISTENTE
 * 
 * Esta API permite mejorar contenido existente en estado "draft" basado en análisis
 * de segmentos de audiencia específicos. Busca contenido existente, lo analiza
 * y genera versiones mejoradas del mismo.
 * 
 * Características principales:
 * - Mejora de contenido existente en lugar de crear nuevo
 * - Búsqueda automática de contenido en estado "draft"
 * - Análisis contextual del contenido actual
 * - Recomendaciones de mejoras específicas
 * - Actualización de contenido existente manteniendo IDs
 * - Soporte para múltiples tipos de contenido
 * - Métricas de mejora y comparación
 * 
 * Documentación completa: /rest-api/analysis/sites/content-improve
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
  'popularity',
  'improvement_potential'
] as const;

const AiProviders = [
  'openai',
  'anthropic',
  'gemini'
] as const;

const ImprovementTypes = [
  'quality',
  'engagement',
  'seo',
  'conversion',
  'readability',
  'all'
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
  sort_by: z.enum(SortOptions).optional().default('improvement_potential'),
  
  // Parámetros específicos de mejora
  improvement_type: z.enum(ImprovementTypes).optional().default('all'),
  include_original: z.boolean().optional().default(true),
  min_improvement_score: z.number().min(0).max(1).optional().default(0.3),
  
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

// Interfaz para contenido existente que se va a mejorar
interface ExistingContentItem {
  id: string;
  type: string;
  title: string;
  description: string;
  content: string;
  url: string;
  duration?: {
    unit: string;
    value: number;
  };
  topics: string[];
  funnelStage: string;
  status: 'draft' | 'published' | 'archived';
  createdAt: string;
  updatedAt: string;
  metrics?: {
    views: number;
    engagement: number;
    conversion: number;
  };
}

// Interfaz para contenido mejorado
interface ImprovedContentItem {
  id: string; // Mantiene el ID original
  type: string;
  title: string;
  description: string;
  content: string;
  url: string;
  duration?: {
    unit: string;
    value: number;
  };
  topics: string[];
  funnelStage: string;
  improvements: {
    type: string[];
    description: string;
    changes: string[];
    expectedImpact: string;
    improvementScore: number;
  };
  comparison: {
    titleChanged: boolean;
    descriptionChanged: boolean;
    contentChanged: boolean;
    topicsAdded: string[];
    topicsRemoved: string[];
  };
  relevanceScore: number;
  engagementPrediction: {
    score: number;
    metrics: Record<string, string>;
  };
  format?: string;
  readingLevel?: string;
  difficultyLevel?: string;
  seoImprovements?: {
    keywords: string[];
    metaDescription: string;
    headings: string[];
  };
}

// Interfaz para la respuesta de mejora de contenido
interface ContentImprovementResponse {
  url: string;
  segment_id?: string;
  operation: 'update';
  targets: string[]; // IDs del contenido actualizado
  improvements: Array<ImprovedContentItem>;
  original_content?: Array<ExistingContentItem>;
  total_content_analyzed: number;
  content_improved: number;
  metadata: {
    request: {
      timestamp: string;
      parameters: Record<string, any>;
    };
    analysis: {
      modelUsed: string;
      aiProvider: string;
      processingTime: string;
      contentSource: string;
      improvementTypes: string[];
      averageImprovementScore: number;
    };
  };
}

// Interfaz para análisis de todos los segmentos con mejoras
interface AllSegmentsImprovementResponse {
  url: string;
  analysis_type: "all_segments_improvement";
  operation: 'update';
  segments_summary: Array<{
    segment_id: string;
    segment_name: string;
    content_analyzed: number;
    content_improved: number;
    average_improvement_score: number;
    top_improvement_types: string[];
  }>;
  global_improvements: Array<ImprovedContentItem>;
  targets: string[]; // IDs de todo el contenido actualizado
  total_segments_analyzed: number;
  total_content_improved: number;
  metadata: {
    request: {
      timestamp: string;
      parameters: Record<string, any>;
    };
    analysis: {
      modelUsed: string;
      aiProvider: string;
      processingTime: string;
      contentSource: string;
      improvementTypes: string[];
      averageImprovementScore: number;
    };
  };
}

/**
 * Busca contenido existente en estado draft desde la base de datos real
 */
async function findDraftContent(params: z.infer<typeof RequestSchema>): Promise<ExistingContentItem[]> {
  console.log('[API:content/improve] Searching for draft content in database');
  
  try {
    // Primero verificar si existe contenido para este site
    console.log(`[API:content/improve] Checking content for site_id: ${params.site_id}`);
    
    // Consulta inicial para ver todo el contenido del site
    const { data: allSiteContent, error: allError } = await supabaseAdmin
      .from('content')
      .select('id, title, status, site_id')
      .eq('site_id', params.site_id);
    
    if (allError) {
      console.error('[API:content/improve] Error checking site content:', allError);
    } else {
      console.log(`[API:content/improve] Total content for site ${params.site_id}: ${allSiteContent?.length || 0}`);
      if (allSiteContent && allSiteContent.length > 0) {
        const statusCounts = allSiteContent.reduce((acc, item) => {
          acc[item.status] = (acc[item.status] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        console.log('[API:content/improve] Content status breakdown:', statusCounts);
      }
    }

    // Construir la consulta base para draft content
    let query = supabaseAdmin
      .from('content')
      .select('*')
      .eq('status', 'draft');

    // Filtrar por site_id si está disponible
    if (params.site_id) {
      query = query.eq('site_id', params.site_id);
      console.log(`[API:content/improve] Filtering by site_id: ${params.site_id}`);
    }

    // Filtrar por segment_id si está disponible
    if (params.segment_id) {
      query = query.eq('segment_id', params.segment_id);
      console.log(`[API:content/improve] Filtering by segment_id: ${params.segment_id}`);
    }

    // Limitar resultados
    query = query.limit(params.limit);

    // Ordenar por fecha de actualización (más recientes primero)
    query = query.order('updated_at', { ascending: false });

    console.log('[API:content/improve] Executing database query for draft content');
    const { data, error } = await query;

    if (error) {
      console.error('[API:content/improve] Database error:', error);
      // En caso de error, devolver array vacío en lugar de fallar
      return [];
    }

    if (!data || data.length === 0) {
      console.log('[API:content/improve] No draft content found in database');
      return [];
    }

    console.log(`[API:content/improve] Found ${data.length} draft content items in database`);

    // Convertir los datos de la DB al formato esperado
    const draftContent: ExistingContentItem[] = data.map(item => {
      // Determinar el tipo basado en el tipo de la DB o inferirlo
      let type = item.type || 'post';
      
      // Mapear tipos de la DB a los tipos esperados por la API
      const typeMapping: Record<string, string> = {
        'blog_post': 'posts',
        'social_post': 'social',
        'email_newsletter': 'social',
        'video_script': 'videos',
        'podcast_script': 'podcasts',
        'infographic': 'downloads',
        'case_study': 'posts',
        'product_guide': 'downloads',
        'faq_section': 'posts',
        'landing_page_copy': 'ads'
      };

      const mappedType = typeMapping[type] || type;

      // Extraer topics del metadata si existe
      let topics: string[] = [];
      if (item.metadata && item.metadata.topics && Array.isArray(item.metadata.topics)) {
        topics = item.metadata.topics;
      }

      // Determinar funnel stage del metadata o usar 'awareness' por defecto
      let funnelStage = 'awareness';
      if (item.metadata && item.metadata.funnel_stage) {
        funnelStage = item.metadata.funnel_stage;
      }

      // Calcular duración estimada del metadata
      let duration;
      if (item.metadata && item.metadata.estimated_reading_time) {
        duration = {
          unit: 'seconds',
          value: parseInt(item.metadata.estimated_reading_time) || 60
        };
      }

      // Generar URL basada en el site y tipo de contenido
      let contentUrl = params.url;
      if (mappedType === 'posts') {
        contentUrl += `/blog/${item.id}`;
      } else if (mappedType === 'videos') {
        contentUrl += `/videos/${item.id}`;
      } else if (mappedType === 'podcasts') {
        contentUrl += `/podcasts/${item.id}`;
      } else {
        contentUrl += `/content/${item.id}`;
      }

      return {
        id: item.id,
        type: mappedType,
        title: item.title || 'Sin título',
        description: item.description || '',
        content: item.text || item.content || '',
        url: contentUrl,
        duration,
        topics,
        funnelStage,
        status: 'draft',
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        metrics: {
          views: 0,
          engagement: 0,
          conversion: 0
        }
      };
    });

    // Filtrar por tipos de contenido solicitados
    const filteredContent = draftContent.filter(item => 
      params.content_types.includes(item.type as any)
    );

    // Filtrar por stage del funnel si no es 'all'
    const finalContent = params.funnel_stage === 'all' 
      ? filteredContent 
      : filteredContent.filter(item => item.funnelStage === params.funnel_stage);

    console.log(`[API:content/improve] After filtering: ${finalContent.length} draft content items`);
    return finalContent.slice(0, params.limit);

  } catch (error) {
    console.error('[API:content/improve] Error searching for draft content:', error);
    // En caso de error, devolver array vacío
    return [];
  }
}

/**
 * Prepara el prompt para la mejora de contenido
 */
function prepareContentImprovementPrompt(
  params: z.infer<typeof RequestSchema>, 
  existingContent: ExistingContentItem[]
): string {
  console.log('[API:content/improve] Preparing content improvement prompt');

  const improvementTypeStr = params.improvement_type === 'all' 
    ? 'todos los aspectos (calidad, engagement, SEO, conversión, legibilidad)'
    : params.improvement_type;

  const segmentContext = params.segment_id 
    ? `para el segmento específico "${params.segment_id}"`
    : 'para todos los segmentos de audiencia disponibles';

  let prompt = `Analiza y mejora el siguiente contenido existente en estado "draft" del sitio web ${params.url} ${segmentContext}.

CONTENIDO EXISTENTE A MEJORAR:
${existingContent.map((content, index) => `
--- CONTENIDO ${index + 1} ---
ID: ${content.id}
Tipo: ${content.type}
Título: ${content.title}
Descripción: ${content.description}
Contenido: ${content.content}
URL: ${content.url}
Temas: ${content.topics.join(', ')}
Funnel Stage: ${content.funnelStage}
Duración: ${content.duration ? `${content.duration.value} ${content.duration.unit}` : 'N/A'}
Estado: ${content.status}
Fecha creación: ${content.createdAt}
Métricas actuales: ${JSON.stringify(content.metrics)}
`).join('\n')}

INSTRUCCIONES DE MEJORA:
- Tipo de mejora solicitada: ${improvementTypeStr}
- Puntuación mínima de mejora requerida: ${params.min_improvement_score}
- Mantener los IDs originales del contenido
- Mejorar cada pieza de contenido manteniendo su propósito original
- Generar mejoras específicas y medibles
- Incluir comparaciones detalladas entre el contenido original y mejorado

Tu respuesta debe ser un objeto JSON estructurado con los siguientes campos principales:
- url: URL del sitio analizado
- segment_id: ID del segmento (si se proporcionó)
- operation: "update"
- targets: array con los IDs del contenido actualizado
- improvements: array de contenido mejorado
- original_content: array del contenido original (si include_original es true)
- total_content_analyzed: número total de contenidos analizados
- content_improved: número de contenidos efectivamente mejorados
- metadata: metadatos de la solicitud y análisis

Cada elemento en el array "improvements" debe incluir:
- id: ID original del contenido (mantenido)
- type: tipo de contenido
- title: título mejorado
- description: descripción mejorada
- content: contenido mejorado
- url: URL del contenido
- duration: duración actualizada si aplica
- topics: temas actualizados/optimizados
- funnelStage: etapa del funnel
- improvements: objeto con detalles de las mejoras realizadas
- comparison: objeto con comparación detallada
- relevanceScore: puntuación de relevancia
- engagementPrediction: predicción de engagement mejorado
- seoImprovements: mejoras específicas de SEO si aplica

IMPORTANTE: 
- Mantén SIEMPRE los IDs originales del contenido
- Asegúrate de que la operación sea "update"
- Incluye todos los IDs actualizados en el array "targets"
- Proporciona mejoras reales y específicas, no genéricas
- Sigue EXACTAMENTE la estructura solicitada`;

  console.log('[API:content/improve] Prompt prepared, length:', prompt.length);
  return prompt;
}

/**
 * Procesa la respuesta de la IA para mejoras de contenido
 */
function processImprovementResponse(
  aiResponse: any, 
  params: z.infer<typeof RequestSchema>, 
  existingContent: ExistingContentItem[],
  startTime: number
): ContentImprovementResponse | AllSegmentsImprovementResponse {
  console.log('[API:content/improve] Processing AI improvement response');
  
  const processingTimeMs = Date.now() - startTime;
  
  // Verificar si es una respuesta válida
  if (aiResponse && typeof aiResponse === 'object' && Array.isArray(aiResponse.improvements)) {
    console.log('[API:content/improve] AI response has expected structure');
    
    // Asegurar que la operación sea "update"
    aiResponse.operation = 'update';
    
    // Extraer todos los IDs de las mejoras para el array targets
    aiResponse.targets = aiResponse.improvements.map((improvement: any) => improvement.id);
    
    // Asegurar metadatos completos
    if (!aiResponse.metadata) {
      aiResponse.metadata = {};
    }
    
    if (!aiResponse.metadata.request) {
      aiResponse.metadata.request = {
        timestamp: new Date().toISOString(),
        parameters: {
          segment_id: params.segment_id,
          improvement_type: params.improvement_type,
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
        contentSource: `draft_content (${existingContent.length} items found)`,
        improvementTypes: [params.improvement_type],
        averageImprovementScore: 0.5
      };
    } else {
      aiResponse.metadata.analysis.processingTime = `${processingTimeMs} ms`;
    }
    
    // Incluir contenido original si se solicitó
    if (params.include_original) {
      aiResponse.original_content = existingContent;
    }
    
    // Asegurar contadores correctos
    aiResponse.total_content_analyzed = existingContent.length;
    aiResponse.content_improved = aiResponse.improvements.length;
    
    return aiResponse as ContentImprovementResponse;
  }
  
  // Error cuando no se puede procesar la respuesta de la IA
  console.log('[API:content/improve] AI response invalid, throwing error');
  throw new Error('La respuesta de la IA no tiene la estructura esperada o está vacía');
}



/**
 * POST /api/site/content/improve
 * 
 * Endpoint para mejorar contenido existente en estado draft.
 */
export async function POST(request: NextRequest) {
  console.log('[API:content/improve] POST request received');
  
  try {
    // Validar el cuerpo de la solicitud
    console.log('[API:content/improve] Parsing request body');
    const body = await request.json();
    console.log('[API:content/improve] Request body parsed:', JSON.stringify(body).substring(0, 200) + '...');
    
    const validationResult = RequestSchema.safeParse(body);
    console.log('[API:content/improve] Validation result success:', validationResult.success);
    
    if (!validationResult.success) {
      console.log('[API:content/improve] Validation failed:', JSON.stringify(validationResult.error.format()));
      return NextResponse.json(
        { 
          error: 'Parámetros inválidos', 
          details: validationResult.error.format() 
        },
        { status: 400 }
      );
    }

    const params = validationResult.data;
    console.log('[API:content/improve] Validated params:', JSON.stringify(params));
    
    // Buscar contenido existente en draft
    console.log('[API:content/improve] Searching for existing draft content');
    const existingContent = await findDraftContent(params);
    
    if (existingContent.length === 0) {
      console.log('[API:content/improve] No draft content found');
      return NextResponse.json(
        { 
          url: params.url,
          segment_id: params.segment_id || null,
          operation: 'update',
          targets: [],
          improvements: [],
          total_content_analyzed: 0,
          content_improved: 0,
          error: {
            code: 404,
            message: 'No se encontró contenido en estado draft para mejorar',
            details: 'Verifica que exista contenido en draft con los filtros especificados'
          }
        },
        { status: 404 }
      );
    }
    
    console.log(`[API:content/improve] Found ${existingContent.length} draft content items to improve`);
    
    // Iniciar timestamp para tracking de tiempo
    const startTime = Date.now();
    console.log('[API:content/improve] Improvement analysis started at:', new Date(startTime).toISOString());
    
    // Preparar el prompt para la mejora
    const prompt = prepareContentImprovementPrompt(params, existingContent);
    
    // Llamar a la API de conversación para obtener las mejoras
    console.log('[API:content/improve] Calling conversation API with model:', params.modelId);
    
    let aiResponse;
    try {
      console.log('[API:content/improve] Initiating request to conversation API...');
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
      console.log('[API:content/improve] Received response from conversation API');
    } catch (conversationError: any) {
      console.error('[API:content/improve] Error in conversation API:', conversationError);
      
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
    console.log('[API:content/improve] Processing AI response');
    const improvementData = processImprovementResponse(aiResponse, params, existingContent, startTime);
    console.log('[API:content/improve] AI response processed');
    
    // Calcular tiempo de procesamiento real
    const processingTimeMs = Date.now() - startTime;
    if (improvementData.metadata && improvementData.metadata.analysis) {
      improvementData.metadata.analysis.processingTime = `${processingTimeMs} ms`;
    }
    console.log('[API:content/improve] Improvement analysis completed in', processingTimeMs, 'ms');
    
    // Verificar si se generaron mejoras
    const hasImprovements = 
      ('improvements' in improvementData && improvementData.improvements.length > 0) ||
      ('global_improvements' in improvementData && improvementData.global_improvements.length > 0);
    
    if (!hasImprovements) {
      console.warn('[API:content/improve] No content improvements generated');
      return NextResponse.json(
        { 
          url: params.url,
          segment_id: params.segment_id || null,
          operation: 'update',
          targets: [],
          improvements: [],
          total_content_analyzed: existingContent.length,
          content_improved: 0,
          error: {
            code: 422,
            message: 'No se pudieron generar mejoras para el contenido existente',
            details: 'El contenido puede estar ya optimizado o requerir parámetros diferentes'
          }
        },
        { status: 422 }
      );
    }
    
    console.log('[API:content/improve] Returning improvement response with status 200');
    return NextResponse.json(improvementData, { status: 200 });
    
  } catch (error: any) {
    console.error('[API:content/improve] Unexpected error:', error);
    
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
 * GET /api/site/content/improve
 * 
 * Obtiene información sobre el servicio de mejora de contenido.
 */
export async function GET(request: NextRequest) {
  console.log('[API:content/improve] GET request received');
  
  const serviceInfo = {
    service: "API de Mejora de Contenido Existente",
    version: "1.0.0",
    status: "operational",
    capabilities: [
      "content-improvement",
      "draft-content-analysis",
      "segment-based-optimization",
      "quality-enhancement",
      "seo-optimization",
      "engagement-improvement"
    ],
    supportedContentTypes: ContentTypes,
    supportedFunnelStages: FunnelStages,
    supportedSortOptions: SortOptions,
    supportedAiProviders: AiProviders,
    supportedImprovementTypes: ImprovementTypes,
    operation: "update",
    limits: {
      maxContentPerRequest: 50,
      requestsPerDay: 100,
      maxTimeout: 120000,
      minImprovementScore: 0.0,
      maxImprovementScore: 1.0
    },
    requirements: {
      contentStatus: "draft",
      contentSource: "existing_content_database"
    }
  };
  
  console.log('[API:content/improve] Returning service info with status 200');
  return NextResponse.json(serviceInfo, { status: 200 });
} 