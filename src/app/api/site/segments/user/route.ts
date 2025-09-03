import { NextRequest, NextResponse } from 'next/server'
import { getUserSegments, DbSegment } from '@/lib/services/segment-service'
import { analyzeWithConversationApi } from '@/lib/services/conversation-client'
import { z } from 'zod'

/**
 * API DE SEGMENTOS DE USUARIO (M2M)
 * 
 * Este endpoint permite obtener o generar segmentos para un ID de usuario específico.
 * Opcionalmente puede recibir una URL de sitio para analizar y generar segmentos reales
 * utilizando modelos de IA a través de la API de conversación.
 * 
 * Esta es una API machine-to-machine (M2M) que no requiere autenticación.
 * 
 * Documentación completa: /docs/api/analysis/segments
 */

// Esquema para validar los parámetros de consulta
const QueryParamsSchema = z.object({
  url: z.string().url('Debe ser una URL válida').optional(),
  segmentCount: z.preprocess(
    // Convertir explícitamente a número
    (val) => {
      if (typeof val === 'string') {
        const parsed = parseInt(val, 10);
        return isNaN(parsed) ? undefined : parsed;
      }
      return val;
    },
    z.number().int().min(1).max(20).optional().default(5)
  ),
  // Mantener segmentsToCreate para compatibilidad con versiones anteriores
  segmentsToCreate: z.preprocess(
    // Convertir explícitamente a número
    (val) => {
      if (typeof val === 'string') {
        const parsed = parseInt(val, 10);
        return isNaN(parsed) ? undefined : parsed;
      }
      return val;
    },
    z.number().int().min(1).max(20).optional()
  ),
  userId: z.string().optional().default('system_m2m_user'),
  debug: z.preprocess(
    // Convertir a booleano
    (val) => {
      if (typeof val === 'string') {
        return val.toLowerCase() === 'true';
      }
      return !!val;
    },
    z.boolean().optional().default(false)
  ),
  modelType: z.enum(['anthropic', 'openai', 'gemini']).optional().default('anthropic'),
  modelId: z.string().optional().default('claude-3-5-sonnet-20240620')
});

/**
 * GET /api/site/segments/user
 * 
 * Obtiene o genera segmentos para un ID de usuario específico.
 * Si se proporciona una URL, genera nuevos segmentos basados en el análisis de esa URL.
 * 
 * Parámetros de consulta:
 * - url: URL opcional del sitio a analizar (ej: https://ejemplo.com)
 * - segmentCount: Número de segmentos a crear (1-20, por defecto 5)
 * - segmentsToCreate: Número de segmentos a crear (1-20, por defecto 5)
 * - userId: ID del usuario para asociar los segmentos (por defecto: system_m2m_user)
 * - debug: Si es true, incluye información adicional de depuración en la respuesta
 * 
 * Ejemplo: /api/site/segments/user?url=https://ejemplo.com&segmentCount=5&segmentsToCreate=5&userId=client_123
 * 
 * Respuesta:
 * {
 *   "userId": "client_123",
 *   "totalSegments": 3,
 *   "siteUrl": "https://ejemplo.com",
 *   "segments": [
 *     {
 *       "id": "db_seg_123456",
 *       "name": "Nombre del segmento",
 *       "description": "Descripción del segmento",
 *       "createdAt": "2023-06-15T14:30:00Z",
 *       "updatedAt": "2023-06-15T14:30:00Z",
 *       "profitabilityScore": 0.88,
 *       "siteUrl": "https://ejemplo.com",
 *       "inUse": true,
 *       "campaigns": 0,
 *       "isAiGenerated": true
 *     },
 *     ...
 *   ]
 * }
 */
export async function GET(request: NextRequest) {
  try {
    // Obtener y validar los parámetros de consulta
    const { searchParams } = new URL(request.url);
    const validationResult = QueryParamsSchema.safeParse(Object.fromEntries(searchParams.entries()));
    
    if (!validationResult.success) {
      return NextResponse.json(
        { 
          error: 'Parámetros inválidos', 
          details: validationResult.error.format() 
        },
        { status: 400 }
      );
    }
    
    const params = validationResult.data;
    
    // Usar segmentCount si está definido, de lo contrario usar segmentsToCreate
    const segmentCountToUse = params.segmentCount !== undefined ? params.segmentCount : params.segmentsToCreate;
    
    // Obtener el ID de usuario (usando el valor por defecto si no se proporciona)
    const userId = params.userId;
    
    // Registrar la solicitud
    console.log(`[API Segments] Solicitud recibida. UserId: ${userId}, URL: ${params.url || 'No proporcionada'}, Segmentos a crear: ${segmentCountToUse}, Debug: ${params.debug}`);
    
    // Registrar inicio de la solicitud con timestamp para medir duración
    const startTime = Date.now();
    
    // Si se proporciona una URL, realizar análisis real
    if (params.url) {
      try {
        console.log(`[API Segments] Iniciando análisis real para: ${params.url}`);
        
        // Validar la URL antes de continuar
        if (!isValidUrl(params.url)) {
          throw new Error(`URL inválida: ${params.url}`);
        }
        
        // Prompt para solicitar segmentos
        const prompt = `Analiza exhaustivamente el sitio web ${params.url} y genera exactamente ${segmentCountToUse} segmentos de audiencia rentables basados en el contenido, diseño, propósito y comportamiento de usuarios del sitio.

Para cada segmento, debes proporcionar:
1. Un ID único con formato "seg_nombre_descriptivo"
2. Nombre claro y específico del segmento
3. Descripción detallada que explique quiénes son, sus características y comportamientos
4. Resumen conciso (1-2 frases) que capture la esencia del segmento
5. Tamaño estimado como porcentaje de la audiencia total
6. Puntuación de rentabilidad (0-1) basada en potencial de monetización
7. Puntuación de confianza (0-1) sobre la precisión del análisis
8. Categoría principal de audiencia (ej: "retail", "technology", "media_entertainment")
9. Perfil de audiencia con datos para plataformas publicitarias y uso cross-platform
10. Código de idioma principal (ej: "es-ES", "en-US")
11. Atributos demográficos, conductuales, psicográficos y tecnográficos
12. Oportunidades de monetización específicas con tipo, ingresos potenciales, dificultad y tasa de conversión
13. Acciones recomendadas con prioridad, impacto esperado y plazo
14. Justificación clara de por qué este segmento es rentable

Además, proporciona:
- Contexto del sitio: industria, modelo de negocio, audiencia principal y posición competitiva
- Próximos pasos recomendados con acciones, prioridad y recursos necesarios
- Cualquier error o limitación encontrada durante el análisis

IMPORTANTE: Este es un análisis real, NO devuelvas datos de ejemplo o simulados. Cada segmento debe ser único, específico y basado en el análisis real del sitio ${params.url}. NO uses segmentos genéricos a menos que sean genuinamente relevantes para este sitio específico.`;
        
        // Llamar directamente a la API de conversación para obtener segmentos reales
        const result = await analyzeWithConversationApi(
          prompt,
          params.modelType,
          params.modelId,
          params.url,
          true, // Incluir screenshot
          60000, // Timeout de 60 segundos
          params.debug, // Modo de depuración
          true // toJSON: true para asegurar que la respuesta sea JSON
        );
        
        // Registrar fin de la solicitud y calcular duración
        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000; // en segundos
        
        console.log(`[API Segments] Análisis completado en ${duration.toFixed(2)} segundos`);
        
        // Verificar si el resultado tiene segmentos válidos
        let finalResult = result;
        
        // Si no hay segmentos o hay errores, intentar con /api/ai como fallback
        if (!result.segments || result.segments.length === 0 || (result.errors && result.errors.length > 0)) {
          console.log('[API Segments] No se encontraron segmentos válidos o hay errores. Intentando con /api/ai como fallback');
          
          try {
            // Construir la URL para la API de AI
            const apiUrl = new URL('/api/ai', process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').toString();
            
            // Preparar los mensajes para la API de AI
            const systemMessage = `Eres un experto en análisis de segmentos de audiencia para sitios web. Tu tarea es identificar exactamente el número solicitado de segmentos más rentables basándote en el contenido, diseño y propósito del sitio.

IMPORTANTE: DEBES responder ÚNICAMENTE con un objeto JSON válido que contenga la estructura exacta especificada y EXACTAMENTE el número de segmentos solicitados, ni más ni menos.`;

            const userMessage = `Analiza el sitio web ${params.url} y genera exactamente ${segmentCountToUse} segmentos de audiencia rentables.

${prompt}

IMPORTANTE: Este es un análisis real, NO devuelvas datos de ejemplo o simulados. Cada segmento debe ser único, específico y basado en el análisis real del sitio ${params.url}.`;

            // Realizar la solicitud a /api/ai
            const aiResponse = await fetch(apiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                messages: [
                  { role: 'system', content: systemMessage },
                  { role: 'user', content: userMessage }
                ],
                modelType: params.modelType === 'anthropic' ? 'openai' : params.modelType, // Si es anthropic, usar openai como fallback
                modelId: params.modelType === 'anthropic' ? 'gpt-5-nano' : params.modelId      // Si es anthropic, usar gpt-5-nano como fallback
              })
            });
            
            if (aiResponse.ok) {
              const aiData = await aiResponse.json();
              
              // Verificar si la respuesta de /api/ai tiene la estructura esperada
              if (aiData && aiData.content) {
                console.log('[API Segments] Fallback exitoso. Se obtuvo respuesta de /api/ai');
                
                // Intentar parsear la respuesta como JSON si es un string
                let parsedContent;
                try {
                  if (typeof aiData.content === 'string') {
                    parsedContent = JSON.parse(aiData.content);
                  } else {
                    parsedContent = aiData.content;
                  }
                  
                  // Verificar si la respuesta tiene la estructura esperada
                  if (parsedContent && parsedContent.segments && Array.isArray(parsedContent.segments)) {
                    console.log(`[API Segments] Fallback exitoso. Se obtuvieron ${parsedContent.segments.length} segmentos`);
                    finalResult = parsedContent;
                  } else {
                    console.log('[API Segments] La respuesta de fallback no tiene la estructura esperada');
                    // Crear una estructura básica si no existe
                    finalResult = {
                      url: params.url,
                      segmentsAnalyzed: 0,
                      segmentsCreated: 0,
                      segmentsUpdated: 0,
                      segments: [],
                      siteContext: {},
                      analysisMetadata: {
                        timestamp: new Date().toISOString(),
                        aiModel: aiData.model || `${params.modelType}/${params.modelId}`,
                        confidenceOverall: 0.5,
                        processingTime: duration * 1000
                      },
                      nextSteps: [],
                      errors: [
                        {
                          code: "PARSING_ERROR",
                          message: "No se pudo obtener segmentos válidos del análisis",
                          affectedSegments: [],
                          severity: "media"
                        }
                      ],
                      rawResponse: aiData.content // Incluir la respuesta original para depuración
                    };
                  }
                } catch (parseError) {
                  console.error('[API Segments] Error al parsear respuesta de fallback:', parseError);
                  // Crear una estructura básica en caso de error de parseo
                  finalResult = {
                    url: params.url,
                    segmentsAnalyzed: 0,
                    segmentsCreated: 0,
                    segmentsUpdated: 0,
                    segments: [],
                    siteContext: {},
                    analysisMetadata: {
                      timestamp: new Date().toISOString(),
                      aiModel: aiData.model || `${params.modelType}/${params.modelId}`,
                      confidenceOverall: 0.5,
                      processingTime: duration * 1000
                    },
                    nextSteps: [],
                    errors: [
                      {
                        code: "JSON_PARSE_ERROR",
                        message: "Error al parsear la respuesta como JSON",
                        affectedSegments: [],
                        severity: "alta"
                      }
                    ],
                    rawResponse: aiData.content // Incluir la respuesta original para depuración
                  };
                }
              } else {
                console.log('[API Segments] Fallback no produjo contenido válido');
              }
            } else {
              console.error('[API Segments] Error en fallback a /api/ai:', await aiResponse.text());
            }
          } catch (fallbackError) {
            console.error('[API Segments] Error al intentar fallback con /api/ai:', fallbackError);
          }
        }
        
        // Asegurar que la respuesta tenga la estructura esperada
        if (!finalResult.segments) {
          finalResult.segments = [];
        }
        
        // Asegurar que todos los campos necesarios estén presentes
        finalResult = {
          url: params.url,
          segmentsAnalyzed: finalResult.segmentsAnalyzed || 0,
          segmentsCreated: finalResult.segmentsCreated || 0,
          segmentsUpdated: finalResult.segmentsUpdated || 0,
          segments: finalResult.segments || [],
          siteContext: finalResult.siteContext || {},
          analysisMetadata: finalResult.analysisMetadata || {
            timestamp: new Date().toISOString(),
            aiModel: `${params.modelType}/${params.modelId}`,
            confidenceOverall: 0.5,
            processingTime: duration * 1000
          },
          nextSteps: finalResult.nextSteps || [],
          errors: finalResult.errors || []
        };
        
        // Si no hay errores pero tampoco hay segmentos, añadir un error
        if (finalResult.segments.length === 0 && (!finalResult.errors || finalResult.errors.length === 0)) {
          finalResult.errors = [
            {
              code: "NO_SEGMENTS_FOUND",
              message: "No se encontraron segmentos para este sitio",
              affectedSegments: [],
              severity: "media"
            }
          ];
        }
        
        // Devolver la respuesta directamente de la API de conversación
        return NextResponse.json({
          userId: userId,
          totalSegments: finalResult.segments?.length || 0,
          siteUrl: params.url,
          segmentsToCreate: segmentCountToUse,
          debug: params.debug,
          processingTime: `${duration.toFixed(2)} segundos`,
          isDirectApiCall: true, // Indicador de que se llamó directamente a la API
          ...finalResult // Incluir toda la respuesta de la API de conversación
        }, { status: 200 });
      } catch (error: any) {
        console.error('[API Segments] Error en análisis real:', error);
        
        // Si hay un error en el análisis real, devolver el error
        return NextResponse.json(
          { 
            error: 'Error en análisis real', 
            message: error.message || 'Ocurrió un error al analizar el sitio',
            code: 'ANALYSIS_ERROR',
            siteUrl: params.url,
            userId: userId,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
          },
          { status: 500 }
        );
      }
    } else {
      // Si no se proporciona URL, usar el servicio de segmentos para datos simulados
      const userSegments = await getUserSegments(
        userId, 
        undefined, 
        segmentCountToUse,
        params.debug
      );
      
      // Registrar fin de la solicitud y calcular duración
      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000; // en segundos
      
      // Verificar si se obtuvieron segmentos
      if (!userSegments || userSegments.length === 0) {
        console.warn('[API Segments] No se encontraron segmentos');
        
        return NextResponse.json(
          {
            userId: userId,
            totalSegments: 0,
            siteUrl: null,
            segmentsToCreate: segmentCountToUse,
            debug: params.debug,
            processingTime: `${duration.toFixed(2)} segundos`,
            segments: [],
            message: 'No se encontraron segmentos para el usuario especificado',
            receivedParams: validationResult.data
          },
          { status: 200 }
        );
      }
      
      // Construir respuesta
      const response = {
        userId: userId,
        totalSegments: userSegments.length,
        siteUrl: null,
        segmentsToCreate: segmentCountToUse,
        debug: params.debug,
        processingTime: `${duration.toFixed(2)} segundos`,
        segments: userSegments.map((segment: DbSegment) => {
          const segmentResponse: any = {
            id: segment.id,
            name: segment.name,
            description: segment.description,
            createdAt: segment.created_at,
            updatedAt: segment.updated_at,
            profitabilityScore: segment.profitability_score || 0,
            siteUrl: segment.url,
            inUse: segment.is_active || false,
            campaigns: segment.campaigns || 0,
            isAiGenerated: segment.is_ai_generated || false
          };
          
          // Incluir respuesta cruda si el modo de depuración está activado
          if (params.debug && segment._raw_response) {
            segmentResponse._rawResponse = segment._raw_response;
          }
          
          return segmentResponse;
        })
      };
      
      console.log(`[API Segments] Respuesta simulada. Segmentos: ${userSegments.length}, Tiempo: ${duration.toFixed(2)} segundos`);
      
      return NextResponse.json(response, { status: 200 });
    }
  } catch (error: any) {
    console.error('Error al obtener segmentos del usuario:', error);
    
    return NextResponse.json(
      { 
        error: 'Error al obtener segmentos', 
        message: error.message || 'Ocurrió un error al obtener los segmentos',
        code: error.code || 'INTERNAL_ERROR',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      },
      { status: 500 }
    );
  }
}

/**
 * Valida si una cadena es una URL válida
 * 
 * @param url La URL a validar
 * @returns true si es una URL válida, false en caso contrario
 */
function isValidUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    // Verificar que el protocolo sea http o https
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch (error) {
    return false;
  }
} 