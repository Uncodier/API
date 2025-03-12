import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { analyzeSiteSegments } from '@/lib/services/segment-analyzer-service'

/**
 * API DE ANÁLISIS DE SEGMENTOS RENTABLES
 * 
 * Esta API permite analizar un sitio web para identificar los segmentos de audiencia
 * más rentables, evaluando patrones de comportamiento, demografía y oportunidades
 * de monetización. Además, puede crear automáticamente estos segmentos en la base 
 * de datos del usuario si no existen.
 * 
 * Características principales:
 * - Análisis conversacional con respuestas en formato JSON estructurado
 * - Identificación de los N segmentos más rentables para un sitio web
 * - Creación automática de segmentos en la base de datos del usuario
 * - Análisis basado en múltiples fuentes de datos (comportamiento, demografía, intereses)
 * - Soporte para diferentes modelos de IA para el análisis
 * - Personalización de criterios de rentabilidad y relevancia
 * 
 * Documentación completa: /docs/api/analysis/segments
 */

// Enumeraciones para tipos de datos
const ProfitabilityMetrics = [
  'conversionRate',
  'aov',  // Average Order Value
  'ltv',  // Lifetime Value
  'engagementRate',
  'adRevenue'
] as const;

const SegmentAttributes = [
  'demographic',
  'behavioral',
  'psychographic',
  'technographic'
] as const;

const OperationModes = [
  'analyze',
  'create',
  'update'
] as const;

const AiProviders = [
  'openai',
  'anthropic',
  'gemini'
] as const;

// Esquema para validar el cuerpo de la solicitud POST
const RequestSchema = z.object({
  url: z.string().url('Debe ser una URL válida'),
  segmentCount: z.number().int().min(1).max(20).optional().default(5),
  mode: z.enum(OperationModes).default('analyze'),
  timeout: z.number().int().min(5000).max(60000).default(45000),
  profitabilityMetrics: z.array(z.enum(ProfitabilityMetrics)).optional(),
  minConfidenceScore: z.number().min(0).max(1).default(0.7),
  includeRationale: z.boolean().default(true),
  segmentAttributes: z.array(z.enum(SegmentAttributes)).optional(),
  user_id: z.string().optional(),
  site_id: z.string().optional(),
  industryContext: z.string().optional(),
  additionalInstructions: z.string().optional(),
  aiProvider: z.enum(AiProviders).default('openai'),
  aiModel: z.string().default('gpt-4o'),
  includeScreenshot: z.boolean().default(true)
});

// Mantener la transformación para compatibilidad con versiones anteriores
// que podrían seguir enviando segmentsToCreate
const RequestSchemaWithTransform = RequestSchema.transform(data => {
  // @ts-ignore - Ignorar error de tipo para segmentsToCreate
  if (data.segmentsToCreate !== undefined && data.segmentCount === undefined) {
    // @ts-ignore - Ignorar error de tipo para segmentsToCreate
    data.segmentCount = data.segmentsToCreate;
  }
  return data;
});

// Interfaz para la respuesta de segmentos de audiencia
interface SegmentResponse {
  url: string;
  segmentsAnalyzed: number;
  segmentsCreated?: number;
  segmentsUpdated?: number;
  user_id?: string;
  site_id?: string;
  segments: Array<{
    id: string;
    name: string;
    description: string;
    summary: string;
    estimatedSize: string;
    profitabilityScore: number;
    confidenceScore: number;
    targetAudience: string | string[];
    audienceProfile?: {
      adPlatforms?: Record<string, any>;
      crossPlatformAudience?: Record<string, any>;
    };
    language: string;
    attributes?: {
      demographic?: Record<string, any>;
      behavioral?: Record<string, any>;
      psychographic?: Record<string, any>;
      technographic?: Record<string, any>;
    };
    monetizationOpportunities?: Array<{
      type: string;
      potentialRevenue: string;
      implementationDifficulty: string;
      description: string;
      estimatedConversionRate?: string;
    }>;
    recommendedActions?: Array<{
      action: string;
      priority: string;
      expectedImpact: string;
      timeframe?: string;
    }>;
    createdInDatabase: boolean;
    databaseId?: string;
    rationale?: string;
    databaseInfo?: {
      databaseId: string;
      createdAt: string;
      updatedAt: string;
    };
  }>;
  siteContext?: {
    industry?: string;
    businessModel?: string;
    primaryAudience?: string;
    competitivePosition?: string;
  };
  analysisMetadata: {
    timestamp: string;
    aiModel: string;
    confidenceOverall: number;
    processingTime: number;
  };
  nextSteps?: Array<{
    action: string;
    priority: string;
    resources?: string[];
  }>;
  errors?: Array<{
    code: string;
    message: string;
    affectedSegments?: string[];
    severity: string;
  }>;
}

// Interfaz para la respuesta del servicio
interface ServiceInfoResponse {
  service: string;
  version: string;
  status: string;
  capabilities: string[];
  limits: {
    maxSegmentsPerRequest: number;
    requestsPerDay: number;
    maxTimeout: number;
  };
  supportedProfitabilityMetrics: typeof ProfitabilityMetrics;
}

// Interfaz para la respuesta de segmentos del usuario
interface UserSegmentsResponse {
  userId: string;
  totalSegments: number;
  segments: Array<{
    id: string;
    name: string;
    description: string;
    createdAt: string;
    updatedAt: string;
    profitabilityScore: number;
    siteUrl: string;
    inUse: boolean;
    campaigns: number;
  }>;
}

/**
 * Transforma los segmentos del formato del servicio al formato esperado por la respuesta de la API
 */
function transformSegmentsForResponse(segments: Array<any>): Array<{
  id: string;
  name: string;
  description: string;
  summary: string;
  estimatedSize: string;
  profitabilityScore: number;
  confidenceScore: number;
  targetAudience: string | string[];
  audienceProfile?: {
    adPlatforms?: Record<string, any>;
    crossPlatformAudience?: Record<string, any>;
  };
  language: string;
  attributes?: {
    demographic?: Record<string, any>;
    behavioral?: Record<string, any>;
    psychographic?: Record<string, any>;
    technographic?: Record<string, any>;
  };
  monetizationOpportunities?: Array<{
    type: string;
    potentialRevenue: string;
    implementationDifficulty: string;
    description: string;
    estimatedConversionRate?: string;
  }>;
  recommendedActions?: Array<{
    action: string;
    priority: string;
    expectedImpact: string;
    timeframe?: string;
  }>;
  createdInDatabase: boolean;
  databaseId?: string;
  rationale?: string;
  databaseInfo?: {
    databaseId: string;
    createdAt: string;
    updatedAt: string;
  };
}> {
  return segments.map(segment => {
    // Transformar monetizationOpportunities si existe
    const monetizationOpportunities = segment.monetizationOpportunities?.map((opportunity: any) => ({
      type: opportunity.type || 'unknown',
      potentialRevenue: opportunity.potentialRevenue || 'unknown',
      implementationDifficulty: opportunity.implementationDifficulty || 'medium',
      description: opportunity.description || '',
      estimatedConversionRate: opportunity.estimatedConversionRate
    })) || undefined;

    // Transformar recommendedActions si existe
    const recommendedActions = segment.recommendedActions?.map((action: any) => ({
      action: action.action || action.name || 'unknown',
      priority: action.priority || 'medium',
      expectedImpact: action.expectedImpact || action.impact || 'medium',
      timeframe: action.timeframe
    })) || undefined;

    // Transformar audienceProfile si existe
    const audienceProfile = segment.audienceProfile ? {
      adPlatforms: segment.audienceProfile.adPlatforms,
      crossPlatformAudience: segment.audienceProfile.crossPlatformAudience
    } : undefined;

    // Transformar attributes si existe
    const attributes = segment.attributes ? {
      demographic: segment.attributes.demographic,
      behavioral: segment.attributes.behavioral,
      psychographic: segment.attributes.psychographic,
      technographic: segment.attributes.technographic
    } : undefined;

    // Información sobre la creación en la base de datos
    const createdInDatabase = segment.createdInDatabase === true;
    const databaseId = segment.databaseId;
    const databaseInfo = createdInDatabase && databaseId ? {
      databaseId: databaseId,
      createdAt: segment.createdAt || new Date().toISOString(),
      updatedAt: segment.updatedAt || new Date().toISOString()
    } : undefined;

    return {
      id: segment.id,
      name: segment.name,
      description: segment.description,
      summary: segment.summary,
      estimatedSize: segment.estimatedSize,
      profitabilityScore: segment.profitabilityScore,
      confidenceScore: segment.confidenceScore,
      targetAudience: segment.targetAudience,
      audienceProfile,
      language: segment.language,
      attributes,
      monetizationOpportunities,
      recommendedActions,
      createdInDatabase,
      databaseId,
      rationale: segment.rationale,
      databaseInfo
    };
  });
}

/**
 * Transforma los nextSteps del formato del servicio al formato esperado por la respuesta de la API
 */
function transformNextStepsForResponse(nextSteps?: Array<Record<string, any>>): Array<{
  action: string;
  priority: string;
  resources?: string[];
}> | undefined {
  if (!nextSteps) return undefined;
  
  return nextSteps.map(step => ({
    action: step.action || step.name || 'unknown',
    priority: step.priority || 'medium',
    resources: Array.isArray(step.resources) ? step.resources : undefined
  }));
}

/**
 * Transforma los errors del formato del servicio al formato esperado por la respuesta de la API
 */
function transformErrorsForResponse(errors?: Array<Record<string, any>>): Array<{
  code: string;
  message: string;
  affectedSegments?: string[];
  severity: string;
}> | undefined {
  if (!errors) return undefined;
  
  return errors.map(error => ({
    code: error.code || 'UNKNOWN_ERROR',
    message: error.message || 'Unknown error',
    affectedSegments: Array.isArray(error.affectedSegments) ? error.affectedSegments : undefined,
    severity: error.severity || 'error'
  }));
}

/**
 * POST /api/site/segments
 * 
 * Analiza un sitio web para identificar los segmentos más rentables
 * y opcionalmente los crea en la base de datos según el modo de operación.
 */
export async function POST(request: NextRequest) {
  console.log('[API:segments] POST request received');
  try {
    // Validar el cuerpo de la solicitud
    console.log('[API:segments] Parsing request body');
    const body = await request.json();
    console.log('[API:segments] Request body parsed:', JSON.stringify(body).substring(0, 200) + '...');
    
    const validationResult = RequestSchemaWithTransform.safeParse(body);
    console.log('[API:segments] Validation result success:', validationResult.success);
    
    if (!validationResult.success) {
      console.log('[API:segments] Validation failed:', JSON.stringify(validationResult.error.format()));
      return NextResponse.json(
        { 
          error: 'Parámetros inválidos', 
          details: validationResult.error.format() 
        },
        { status: 400 }
      );
    }

    const params = validationResult.data;
    console.log('[API:segments] Validated params:', JSON.stringify({
      url: params.url,
      segmentCount: params.segmentCount,
      mode: params.mode,
      aiProvider: params.aiProvider,
      aiModel: params.aiModel
    }));
    
    // Verificar que se proporcionen user_id y site_id cuando el modo es 'create'
    if (params.mode === 'create' && (!params.user_id || !params.site_id)) {
      console.log('[API:segments] Missing required parameters for create mode');
      return NextResponse.json(
        { 
          error: 'Parámetros faltantes', 
          details: 'Se requieren user_id y site_id para el modo create' 
        },
        { status: 400 }
      );
    }
    
    // Iniciar timestamp para tracking de tiempo
    const startTime = Date.now();
    console.log('[API:segments] Analysis started at:', new Date(startTime).toISOString());
    
    // Usar el ID de usuario proporcionado o un ID temporal para sistemas m2m
    const userId = params.user_id || 'system_m2m_user';
    
    // Realizar el análisis de segmentos
    console.log('[API:segments] Calling analyzeSiteSegments function');
    const segmentAnalysis = await analyzeSiteSegments({
      url: params.url,
      segmentCount: params.segmentCount,
      mode: params.mode,
      timeout: params.timeout,
      profitabilityMetrics: params.profitabilityMetrics,
      minConfidenceScore: params.minConfidenceScore,
      includeRationale: params.includeRationale,
      segmentAttributes: params.segmentAttributes,
      industryContext: params.industryContext,
      additionalInstructions: params.additionalInstructions,
      aiProvider: params.aiProvider,
      aiModel: params.aiModel,
      userId: userId,
      site_id: params.site_id,
      includeScreenshot: params.includeScreenshot
    });
    console.log('[API:segments] analyzeSiteSegments function returned successfully');
    
    // Calcular tiempo de procesamiento
    const processingTime = Date.now() - startTime;
    console.log('[API:segments] Analysis completed in', processingTime, 'ms');
    
    // Verificar si los segmentos se crearon correctamente en la base de datos
    if (params.mode === 'create') {
      const createdSegments = segmentAnalysis.segments.filter(segment => segment.createdInDatabase);
      console.log('[API:segments] Segments created in database:', createdSegments.length);
      
      if (createdSegments.length === 0) {
        console.warn('[API:segments] No segments were created in the database');
      } else if (createdSegments.length < segmentAnalysis.segments.length) {
        console.warn('[API:segments] Some segments were not created in the database');
      }
      
      // Actualizar el contador de segmentos creados
      segmentAnalysis.segmentsCreated = createdSegments.length;
    }
    
    // Transformar los segmentos para la respuesta
    const transformedSegments = transformSegmentsForResponse(segmentAnalysis.segments);
    const transformedNextSteps = transformNextStepsForResponse(segmentAnalysis.nextSteps);
    const transformedErrors = transformErrorsForResponse(segmentAnalysis.errors);
    
    // Construir respuesta
    console.log('[API:segments] Building response object');
    const response: SegmentResponse = {
      url: params.url,
      segmentsAnalyzed: segmentAnalysis.segments.length,
      segmentsCreated: segmentAnalysis.segmentsCreated,
      segmentsUpdated: segmentAnalysis.segmentsUpdated,
      user_id: params.user_id,
      site_id: params.site_id,
      segments: transformedSegments,
      siteContext: segmentAnalysis.siteContext,
      analysisMetadata: {
        timestamp: new Date().toISOString(),
        aiModel: params.aiModel,
        confidenceOverall: segmentAnalysis.confidenceOverall || 0.8,
        processingTime
      },
      nextSteps: transformedNextSteps,
      errors: transformedErrors
    };
    console.log('[API:segments] Response built, returning with status 200');
    
    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[API:segments] Error in segment analysis:', error);
    console.error('[API:segments] Error details:', error.message, error.stack);
    
    return NextResponse.json(
      { 
        error: 'Error en el análisis', 
        message: error.message || 'Ocurrió un error al analizar los segmentos',
        code: error.code || 'INTERNAL_ERROR'
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/site/segments
 * 
 * Obtiene información sobre el servicio de análisis de segmentos.
 */
export async function GET(request: NextRequest) {
  console.log('[API:segments] GET request received');
  
  const serviceInfo: ServiceInfoResponse = {
    service: "AI Segment Analyzer",
    version: "1.0.0",
    status: "operational",
    capabilities: [
      "segment-identification",
      "profitability-analysis",
      "database-integration",
      "multi-model-support"
    ],
    limits: {
      maxSegmentsPerRequest: 20,
      requestsPerDay: 50,
      maxTimeout: 60000
    },
    supportedProfitabilityMetrics: ProfitabilityMetrics
  };
  
  console.log('[API:segments] Returning service info with status 200');
  return NextResponse.json(serviceInfo, { status: 200 });
} 