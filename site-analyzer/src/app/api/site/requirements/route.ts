import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { analyzeWithConversationApi } from '@/lib/services/conversation-client'

/**
 * API DE REQUISITOS PARA SEGMENTOS
 * 
 * Esta API permite obtener un conjunto de requisitos específicos y recomendaciones técnicas 
 * personalizadas basadas en segmentos de audiencia. Es útil para identificar las necesidades 
 * técnicas, funcionales y de experiencia de usuario que un sitio debe cumplir para satisfacer 
 * a un segmento específico de audiencia.
 * 
 * Características principales:
 * - Requisitos técnicos y funcionales personalizados para segmentos específicos
 * - Análisis de necesidades de accesibilidad, rendimiento y usabilidad
 * - Recomendaciones sobre características y funcionalidades clave
 * - Puntuaciones de prioridad para cada requisito
 * - Evaluación de conformidad del sitio actual con los requisitos identificados
 * - Soporte para diferentes modelos de IA para el análisis de requisitos
 * - Recomendaciones específicas para dispositivos (móvil, desktop, tablet)
 * 
 * Documentación completa: /docs/api/analysis/segments/requirements
 */

// Enumeraciones para tipos de datos
const RequirementTypes = [
  'technical',
  'functional',
  'accessibility',
  'performance',
  'usability',
  'content'
] as const;

const PriorityLevels = [
  'all',
  'critical',
  'high',
  'medium',
  'low'
] as const;

const DeviceTypes = [
  'all',
  'mobile',
  'desktop',
  'tablet'
] as const;

const AiProviders = [
  'openai',
  'anthropic',
  'gemini'
] as const;

// Esquema de validación para la solicitud
const RequestSchema = z.object({
  url: z.string().url('URL inválida'),
  segment_id: z.string().min(1, 'ID de segmento requerido'),
  requirement_types: z.array(z.enum(RequirementTypes)).optional().default(() => [...RequirementTypes]),
  limit: z.number().int().min(1).max(50).optional().default(15),
  user_id: z.string().optional(),
  site_id: z.string().optional(),
  priority_level: z.enum(PriorityLevels).optional().default('all'),
  device_type: z.enum(DeviceTypes).optional().default('all'),
  provider: z.enum(AiProviders).optional().default('anthropic'),
  modelId: z.string().optional().default('claude-3-5-sonnet-20240620'),
  timeout: z.number().int().min(5000).max(120000).optional().default(30000),
  include_implementation: z.boolean().optional().default(true),
  include_conformity: z.boolean().optional().default(true),
  includeScreenshot: z.boolean().optional().default(true)
});

// Interfaces para la respuesta
interface RequirementResponse {
  url: string;
  segment_id: string;
  requirements: Array<RequirementItem>;
  total_requirements: number;
  returned_requirements: number;
  conformity_score: ConformityScore;
  created_requirements: string[];
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
      siteScanDate: string;
      status: string;
      analysisMetrics: string[];
    };
  };
}

interface RequirementItem {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  completion_status: string;
  source: string;
  type: string;
  rationale: string;
  devices: string[];
  implementation?: {
    difficulty: string;
    estimated_time: string;
    technologies: string[];
    suggested_libraries: string[];
    steps: string[];
  };
  conformity?: {
    status: string;
    score: number;
    notes: string;
  };
  impact_score: number;
  created_at: string;
  updated_at: string;
}

interface ConformityScore {
  overall: number;
  by_type: Record<string, number>;
  by_priority: Record<string, number>;
}

/**
 * Genera un ID único para un requisito
 */
function generateRequirementId(type: string): string {
  return `req_${Math.random().toString(36).substring(2, 7)}`;
}

/**
 * Prepara el prompt para el análisis de requisitos
 */
function prepareRequirementsAnalysisPrompt(params: z.infer<typeof RequestSchema>): string {
  const {
    url,
    segment_id,
    requirement_types,
    limit,
    priority_level,
    device_type,
    include_implementation,
    include_conformity
  } = params;

  // Construir el prompt base
  let prompt = `Analiza el sitio web ${url} y genera una lista detallada de requisitos técnicos y funcionales específicos para el segmento de audiencia con ID "${segment_id}".`;
  
  // Añadir detalles sobre tipos de requisitos
  if (requirement_types && requirement_types.length > 0 && !requirement_types.includes('all' as any)) {
    prompt += ` Enfócate en requisitos de tipo: ${requirement_types.join(', ')}.`;
  }
  
  // Añadir detalles sobre nivel de prioridad
  if (priority_level && priority_level !== 'all') {
    prompt += ` Incluye solo requisitos con prioridad ${priority_level} o superior.`;
  }
  
  // Añadir detalles sobre tipo de dispositivo
  if (device_type && device_type !== 'all') {
    prompt += ` Considera específicamente requisitos para dispositivos ${device_type}.`;
  }
  
  // Añadir detalles sobre implementación
  if (include_implementation) {
    prompt += ` Para cada requisito, incluye detalles de implementación como: dificultad, tiempo estimado, tecnologías recomendadas, bibliotecas sugeridas y pasos de implementación.`;
  }
  
  // Añadir detalles sobre conformidad
  if (include_conformity) {
    prompt += ` Evalúa el nivel de conformidad actual del sitio con cada requisito, proporcionando un estado (missing, partial, complete), una puntuación (0-1) y notas explicativas.`;
  }
  
  // Añadir instrucciones sobre el formato de respuesta
  prompt += `\n\nGenera exactamente ${limit} requisitos en formato JSON con la siguiente estructura para cada requisito:
  {
    "id": "req_XXXXX",
    "title": "Título descriptivo del requisito",
    "description": "Descripción detallada del requisito",
    "priority": "critical|high|medium|low",
    "status": "pending|in_progress|completed|rejected",
    "completion_status": "not_started|partial|complete",
    "source": "segment_analysis",
    "type": "${requirement_types.join('|')}",
    "rationale": "Justificación de por qué este requisito es importante para el segmento",
    "devices": ["mobile", "desktop", "tablet"],
    ${include_implementation ? `"implementation": {
      "difficulty": "low|medium|high",
      "estimated_time": "Tiempo estimado (ej: 2-3 semanas)",
      "technologies": ["Lista", "de", "tecnologías"],
      "suggested_libraries": ["Lista", "de", "bibliotecas"],
      "steps": ["Paso 1", "Paso 2", "..."]
    },` : ''}
    ${include_conformity ? `"conformity": {
      "status": "missing|partial|complete",
      "score": 0.0-1.0,
      "notes": "Notas sobre el estado actual"
    },` : ''}
    "impact_score": 0.0-1.0,
    "created_at": "2024-07-15T16:42:18Z",
    "updated_at": "2024-07-15T16:42:18Z"
  }
  
  También incluye una puntuación de conformidad general y desglosada por tipo y prioridad.
  
  La respuesta completa debe seguir este formato:
  {
    "url": "${url}",
    "segment_id": "${segment_id}",
    "requirements": [...],
    "total_requirements": número,
    "returned_requirements": número,
    "conformity_score": {
      "overall": 0.0-1.0,
      "by_type": { "technical": 0.0-1.0, ... },
      "by_priority": { "critical": 0.0-1.0, ... }
    },
    "created_requirements": [],
    "metadata": {
      "request": {
        "timestamp": "ISO date",
        "parameters": { ... }
      },
      "analysis": {
        "modelUsed": "modelo usado",
        "aiProvider": "proveedor",
        "processingTime": "tiempo",
        "segmentDataSource": "fuente",
        "siteScanDate": "fecha",
        "status": "success",
        "analysisMetrics": ["métrica1", ...]
      }
    }
  }`;

  return prompt;
}

/**
 * Procesa la respuesta de la IA y la formatea según la estructura esperada
 */
function processAIResponse(aiResponse: any, params: z.infer<typeof RequestSchema>, startTime: number): RequirementResponse {
  // Calcular tiempo de procesamiento
  const processingTimeMs = Date.now() - startTime;
  const processingTime = `${(processingTimeMs / 1000).toFixed(2)} seconds`;
  
  try {
    // Intentar parsear la respuesta como JSON
    let parsedResponse: RequirementResponse;
    
    if (typeof aiResponse === 'string') {
      // Extraer solo la parte JSON de la respuesta si hay texto adicional
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedResponse = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No se pudo encontrar un objeto JSON válido en la respuesta');
      }
    } else if (typeof aiResponse === 'object') {
      parsedResponse = aiResponse;
    } else {
      throw new Error('Formato de respuesta inesperado');
    }
    
    // Asegurarse de que la respuesta tenga la estructura correcta
    if (!parsedResponse.requirements || !Array.isArray(parsedResponse.requirements)) {
      throw new Error('La respuesta no contiene un array de requisitos válido');
    }
    
    // Asegurarse de que cada requisito tenga un ID único
    parsedResponse.requirements = parsedResponse.requirements.map(req => {
      if (!req.id) {
        req.id = generateRequirementId(req.type || 'unknown');
      }
      return req;
    });
    
    // Asegurarse de que los metadatos estén completos
    if (!parsedResponse.metadata) {
      parsedResponse.metadata = {
        request: {
          timestamp: new Date().toISOString(),
          parameters: params
        },
        analysis: {
          modelUsed: params.modelId,
          aiProvider: params.provider,
          processingTime,
          segmentDataSource: `${params.segment_id} (last updated: ${new Date().toISOString().split('T')[0]})`,
          siteScanDate: new Date().toISOString(),
          status: 'success',
          analysisMetrics: [
            'Patrones de comportamiento del segmento',
            'Necesidades específicas del sector',
            'Estándares de accesibilidad WCAG 2.1',
            'Mejores prácticas de UX/UI 2024'
          ]
        }
      };
    } else {
      // Actualizar solo los campos faltantes en los metadatos
      parsedResponse.metadata.analysis = {
        ...parsedResponse.metadata.analysis,
        modelUsed: parsedResponse.metadata.analysis.modelUsed || params.modelId,
        aiProvider: parsedResponse.metadata.analysis.aiProvider || params.provider,
        processingTime: parsedResponse.metadata.analysis.processingTime || processingTime
      };
    }
    
    return parsedResponse;
    
  } catch (error) {
    console.error('[Requirements API] Error al procesar la respuesta de la IA:', error);
    
    // Generar una respuesta de fallback en caso de error
    return generateFallbackResponse(params, processingTimeMs);
  }
}

/**
 * Genera una respuesta de fallback en caso de error
 */
function generateFallbackResponse(params: z.infer<typeof RequestSchema>, processingTimeMs: number): RequirementResponse {
  const timestamp = new Date().toISOString();
  const processingTime = `${(processingTimeMs / 1000).toFixed(2)} seconds`;
  
  // Crear un conjunto de requisitos de ejemplo
  const requirements: RequirementItem[] = [];
  
  // Añadir algunos requisitos de ejemplo basados en los tipos solicitados
  if (params.requirement_types.includes('technical') || params.requirement_types.includes('functional')) {
    requirements.push({
      id: generateRequirementId('technical'),
      title: 'Implementación de sistema de autenticación seguro',
      description: 'El sitio debe implementar un sistema de autenticación seguro con soporte para autenticación de dos factores y gestión de sesiones.',
      priority: 'high',
      status: 'pending',
      completion_status: 'not_started',
      source: 'segment_analysis',
      type: 'technical',
      rationale: 'Los usuarios de este segmento requieren altos niveles de seguridad para proteger sus datos sensibles.',
      devices: ['all'],
      implementation: params.include_implementation ? {
        difficulty: 'medium',
        estimated_time: '2-3 semanas',
        technologies: ['OAuth 2.0', 'JWT', 'HTTPS'],
        suggested_libraries: ['Auth0', 'Passport.js', 'NextAuth'],
        steps: [
          'Implementar autenticación básica con email/password',
          'Añadir soporte para autenticación de dos factores',
          'Configurar políticas de seguridad para sesiones',
          'Implementar recuperación de contraseñas segura'
        ]
      } : undefined,
      conformity: params.include_conformity ? {
        status: 'partial',
        score: 0.4,
        notes: 'El sitio tiene autenticación básica pero carece de 2FA y políticas de seguridad robustas.'
      } : undefined,
      impact_score: 0.85,
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  
  if (params.requirement_types.includes('accessibility')) {
    requirements.push({
      id: generateRequirementId('accessibility'),
      title: 'Mejora de contraste de color y tamaño de texto',
      description: 'Optimizar el contraste de color y permitir ajustes de tamaño de texto para cumplir con WCAG 2.1 AA.',
      priority: 'medium',
      status: 'pending',
      completion_status: 'not_started',
      source: 'segment_analysis',
      type: 'accessibility',
      rationale: 'Este segmento incluye usuarios con discapacidades visuales que requieren mejor contraste y opciones de texto.',
      devices: ['all'],
      implementation: params.include_implementation ? {
        difficulty: 'low',
        estimated_time: '1 semana',
        technologies: ['CSS', 'HTML'],
        suggested_libraries: ['axe-core', 'react-aria'],
        steps: [
          'Auditar el sitio con herramientas de accesibilidad',
          'Ajustar la paleta de colores para mejorar el contraste',
          'Implementar controles de tamaño de texto',
          'Añadir atributos ARIA donde sea necesario'
        ]
      } : undefined,
      conformity: params.include_conformity ? {
        status: 'missing',
        score: 0.1,
        notes: 'El sitio actual tiene problemas significativos de contraste y no ofrece opciones de accesibilidad.'
      } : undefined,
      impact_score: 0.75,
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  
  if (params.requirement_types.includes('performance')) {
    requirements.push({
      id: generateRequirementId('performance'),
      title: 'Optimización de carga para conexiones lentas',
      description: 'Optimizar el rendimiento del sitio para usuarios con conexiones de internet lentas o inestables.',
      priority: 'high',
      status: 'pending',
      completion_status: 'not_started',
      source: 'segment_analysis',
      type: 'performance',
      rationale: 'Este segmento incluye usuarios en áreas con infraestructura de internet limitada.',
      devices: ['mobile', 'desktop'],
      implementation: params.include_implementation ? {
        difficulty: 'medium',
        estimated_time: '2 semanas',
        technologies: ['Lazy loading', 'Image optimization', 'Service Workers'],
        suggested_libraries: ['next/image', 'Workbox', 'webpack'],
        steps: [
          'Implementar lazy loading para imágenes y componentes',
          'Optimizar y comprimir recursos estáticos',
          'Implementar estrategias de caching con Service Workers',
          'Añadir soporte para modo offline básico'
        ]
      } : undefined,
      conformity: params.include_conformity ? {
        status: 'partial',
        score: 0.3,
        notes: 'El sitio tiene algunas optimizaciones básicas pero no está optimizado para conexiones lentas.'
      } : undefined,
      impact_score: 0.8,
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  
  // Limitar el número de requisitos según el parámetro limit
  const limitedRequirements = requirements.slice(0, params.limit);
  
  return {
    url: params.url,
    segment_id: params.segment_id,
    requirements: limitedRequirements,
    total_requirements: requirements.length,
    returned_requirements: limitedRequirements.length,
    conformity_score: {
      overall: 0.27,
      by_type: {
        technical: 0.4,
        functional: 0.35,
        accessibility: 0.1,
        performance: 0.3,
        usability: 0.25,
        content: 0.2
      },
      by_priority: {
        critical: 0.2,
        high: 0.35,
        medium: 0.3,
        low: 0.4
      }
    },
    created_requirements: [],
    metadata: {
      request: {
        timestamp,
        parameters: params
      },
      analysis: {
        modelUsed: params.modelId,
        aiProvider: params.provider,
        processingTime,
        segmentDataSource: `${params.segment_id} (last updated: ${new Date().toISOString().split('T')[0]})`,
        siteScanDate: timestamp,
        status: 'fallback',
        analysisMetrics: [
          'Respuesta de fallback generada debido a un error en el procesamiento'
        ]
      }
    }
  };
}

/**
 * Endpoint POST para el análisis de requisitos
 */
export async function POST(request: NextRequest) {
  console.log('[Requirements API] Recibida solicitud POST');
  const startTime = Date.now();
  
  try {
    // Parsear el cuerpo de la solicitud
    const body = await request.json();
    
    // Validar los parámetros de la solicitud
    const validationResult = RequestSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.error('[Requirements API] Error de validación:', validationResult.error);
      
      return NextResponse.json(
        {
          error: 'Parámetros inválidos',
          details: validationResult.error.errors
        },
        { status: 400 }
      );
    }
    
    const params = validationResult.data;
    console.log('[Requirements API] Parámetros validados:', JSON.stringify(params));
    
    // Preparar el prompt para el análisis
    const prompt = prepareRequirementsAnalysisPrompt(params);
    
    // Llamar a la API de conversación para obtener el análisis
    const aiResponse = await analyzeWithConversationApi(
      prompt,
      params.provider,
      params.modelId,
      params.url,
      params.includeScreenshot,
      params.timeout,
      false, // debugMode
      true // toJSON
    );
    
    // Procesar la respuesta
    const processedResponse = processAIResponse(aiResponse, params, startTime);
    
    // Devolver la respuesta
    return NextResponse.json(processedResponse);
    
  } catch (error) {
    console.error('[Requirements API] Error al procesar la solicitud:', error);
    
    return NextResponse.json(
      {
        error: 'Error interno del servidor',
        message: error instanceof Error ? error.message : 'Error desconocido'
      },
      { status: 500 }
    );
  }
}

/**
 * Endpoint GET para el análisis de requisitos (acepta parámetros como query params)
 */
export async function GET(request: NextRequest) {
  console.log('[Requirements API] Recibida solicitud GET');
  const startTime = Date.now();
  
  try {
    // Obtener los parámetros de la URL
    const url = request.nextUrl.searchParams.get('url');
    const segment_id = request.nextUrl.searchParams.get('segment_id');
    const requirement_types = request.nextUrl.searchParams.get('requirement_types')?.split(',') as z.infer<typeof RequestSchema>['requirement_types'];
    const limit = request.nextUrl.searchParams.get('limit') ? parseInt(request.nextUrl.searchParams.get('limit')!) : undefined;
    const user_id = request.nextUrl.searchParams.get('user_id') || undefined;
    const site_id = request.nextUrl.searchParams.get('site_id') || undefined;
    const priority_level = request.nextUrl.searchParams.get('priority_level') as z.infer<typeof RequestSchema>['priority_level'];
    const device_type = request.nextUrl.searchParams.get('device_type') as z.infer<typeof RequestSchema>['device_type'];
    const provider = request.nextUrl.searchParams.get('provider') as z.infer<typeof RequestSchema>['provider'];
    const modelId = request.nextUrl.searchParams.get('modelId') || undefined;
    const timeout = request.nextUrl.searchParams.get('timeout') ? parseInt(request.nextUrl.searchParams.get('timeout')!) : undefined;
    const include_implementation = request.nextUrl.searchParams.get('include_implementation') === 'true';
    const include_conformity = request.nextUrl.searchParams.get('include_conformity') === 'true';
    const includeScreenshot = request.nextUrl.searchParams.get('includeScreenshot') !== 'false'; // Por defecto true
    
    // Construir el objeto de parámetros
    const params = {
      url,
      segment_id,
      requirement_types,
      limit,
      user_id,
      site_id,
      priority_level,
      device_type,
      provider,
      modelId,
      timeout,
      include_implementation,
      include_conformity,
      includeScreenshot
    };
    
    // Validar los parámetros
    const validationResult = RequestSchema.safeParse(params);
    
    if (!validationResult.success) {
      console.error('[Requirements API] Error de validación:', validationResult.error);
      
      return NextResponse.json(
        {
          error: 'Parámetros inválidos',
          details: validationResult.error.errors
        },
        { status: 400 }
      );
    }
    
    const validatedParams = validationResult.data;
    console.log('[Requirements API] Parámetros validados:', JSON.stringify(validatedParams));
    
    // Preparar el prompt para el análisis
    const prompt = prepareRequirementsAnalysisPrompt(validatedParams);
    
    // Llamar a la API de conversación para obtener el análisis
    const aiResponse = await analyzeWithConversationApi(
      prompt,
      validatedParams.provider,
      validatedParams.modelId,
      validatedParams.url,
      validatedParams.includeScreenshot,
      validatedParams.timeout,
      false, // debugMode
      true // toJSON
    );
    
    // Procesar la respuesta
    const processedResponse = processAIResponse(aiResponse, validatedParams, startTime);
    
    // Devolver la respuesta
    return NextResponse.json(processedResponse);
    
  } catch (error) {
    console.error('[Requirements API] Error al procesar la solicitud:', error);
    
    return NextResponse.json(
      {
        error: 'Error interno del servidor',
        message: error instanceof Error ? error.message : 'Error desconocido'
      },
      { status: 500 }
    );
  }
} 