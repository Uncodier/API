import { createSegmentInDatabase, updateSegment, findSimilarSegments } from '@/lib/database/segment-db'
import { generateSegmentId } from '../utils/id-generator'
import { analyzeWithConversationApi, sendConversationRequest } from './conversation-client'
import { continueJsonGeneration, isIncompleteJson, attemptJsonRepair } from './continuation-service'

interface SegmentAnalysisOptions {
  url: string;
  segmentCount: number;
  mode: 'analyze' | 'create' | 'update';
  timeout: number;
  profitabilityMetrics?: string[];
  minConfidenceScore: number;
  includeRationale?: boolean;
  segmentAttributes?: string[];
  industryContext?: string;
  additionalInstructions?: string;
  aiProvider: 'openai' | 'anthropic' | 'gemini';
  aiModel: string;
  userId: string;
  site_id?: string;
  includeScreenshot?: boolean;
}

interface SegmentAnalysisResult {
  segments: Array<{
    id: string;
    name: string;
    description: string;
    summary: string;
    estimatedSize: string;
    profitabilityScore?: number;
    confidenceScore?: number;
    targetAudience: string | string[];
    audienceProfile?: Record<string, any>;
    language: string;
    attributes?: Record<string, any>;
    monetizationOpportunities?: Array<Record<string, any>>;
    recommendedActions?: Array<Record<string, any>>;
    createdInDatabase: boolean;
    databaseId?: string;
    rationale?: string;
    error?: boolean;
    errorDetails?: Record<string, any>;
  }>;
  segmentsCreated?: number;
  segmentsUpdated?: number;
  siteContext?: Record<string, any>;
  confidenceOverall?: number;
  nextSteps?: Array<Record<string, any>>;
  errors?: Array<Record<string, any>>;
}

/**
 * Implementación temporal del servicio de análisis de segmentos
 * 
 * Esta es una versión simplificada que devuelve datos de ejemplo para poder
 * probar la API sin dependencias externas.
 */

/**
 * Analiza un sitio web para identificar segmentos rentables (versión de ejemplo)
 * 
 * Esta implementación devuelve datos de ejemplo para poder probar la API
 * sin dependencias externas.
 */
export async function analyzeSiteSegments(options: SegmentAnalysisOptions): Promise<SegmentAnalysisResult> {
  console.log('[SegmentAnalyzer] Starting segment analysis for URL:', options.url);
  console.log('[SegmentAnalyzer] Analysis options:', JSON.stringify({
    segmentCount: options.segmentCount,
    mode: options.mode,
    aiProvider: options.aiProvider,
    aiModel: options.aiModel,
    timeout: options.timeout
  }));
  
  try {
    console.log('[SegmentAnalyzer] Preparing to call AI analysis');
    
    // Preparar el prompt para el análisis
    console.log('[SegmentAnalyzer] Preparing analysis prompt');
    const prompt = prepareSegmentAnalysisPrompt(options);
    console.log('[SegmentAnalyzer] Prompt prepared, length:', prompt.length);
    
    // Aumentar el timeout para respuestas grandes
    const effectiveTimeout = Math.max(options.timeout || 45000, 120000); // Al menos 120 segundos (2 minutos)
    console.log('[SegmentAnalyzer] Using effective timeout:', effectiveTimeout);
    
    // Llamar a la API de conversación
    console.log('[SegmentAnalyzer] Calling conversation API with model:', options.aiModel);
    
    let aiResponse;
    try {
      console.log('[SegmentAnalyzer] Iniciando solicitud a la API de conversación...');
      aiResponse = await analyzeWithConversationApi(
        prompt,
        options.aiProvider,
        options.aiModel,
        options.url,
        options.includeScreenshot,
        effectiveTimeout,  // Usar el timeout aumentado
        false,  // debugMode
        true    // toJSON - asegurar que siempre se solicita JSON
      );
      console.log('[SegmentAnalyzer] Received response from conversation API');
      
      // Verificar si la respuesta tiene metadatos y si la conversación está cerrada o no
      if (aiResponse && typeof aiResponse === 'object' && aiResponse._requestMetadata) {
        console.log('[SegmentAnalyzer] Respuesta contiene metadatos:', 
          JSON.stringify({
            conversationId: aiResponse._requestMetadata.conversationId,
            closed: aiResponse._requestMetadata.closed
          }));
        
        // Si la conversación no está cerrada, intentar continuar con el mismo conversationId
        if (aiResponse._requestMetadata.closed === false && aiResponse._requestMetadata.conversationId) {
          console.log('[SegmentAnalyzer] La conversación no está cerrada, iniciando bucle de continuación');
          
          const conversationId = aiResponse._requestMetadata.conversationId;
          let isClosed = false;
          let continuationResponse = aiResponse;
          let maxAttempts = 5; // Máximo número de intentos de continuación
          let attemptCount = 0;
          
          // Bucle de continuación: seguir intentando hasta que la conversación esté cerrada o se alcance el máximo de intentos
          while (!isClosed && attemptCount < maxAttempts) {
            attemptCount++;
            console.log(`[SegmentAnalyzer] Intento de continuación ${attemptCount} de ${maxAttempts}`);
            
            // Usar un timeout aún mayor para la continuación, aumentando con cada intento
            const continuationTimeout = effectiveTimeout * (1.5 + (attemptCount * 0.1)); // Aumentar 10% por cada intento
            console.log(`[SegmentAnalyzer] Usando timeout extendido para continuación: ${continuationTimeout}ms`);
            
            try {
              // Preparar un mensaje simple para continuar la conversación
              const continuationMessage = {
                role: 'user' as 'system' | 'user' | 'assistant',
                content: 'Por favor, continúa exactamente donde te quedaste y completa la respuesta JSON.'
              };
              
              // Esperar un tiempo antes de intentar de nuevo para dar tiempo al servicio
              const waitTime = 1000 * attemptCount; // Espera creciente: 1s, 2s, 3s...
              console.log(`[SegmentAnalyzer] Esperando ${waitTime}ms antes del siguiente intento...`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              
              // Llamar de nuevo a la API con el mismo conversationId para continuar
              console.log(`[SegmentAnalyzer] Continuando conversación con ID (intento ${attemptCount}):`, conversationId);
              const response = await sendConversationRequest({
                messages: [continuationMessage],
                modelType: options.aiProvider,
                modelId: options.aiModel,
                includeScreenshot: options.includeScreenshot,
                siteUrl: options.url,
                responseFormat: 'json',
                timeout: continuationTimeout,
                conversationId: conversationId
              });
              
              console.log('[SegmentAnalyzer] Respuesta de continuación recibida para intento', attemptCount);
              
              // Si la respuesta de continuación es válida, actualizarla
              if (response && typeof response === 'object') {
                continuationResponse = response;
                
                // Verificar si la conversación ahora está cerrada
                if (continuationResponse._requestMetadata && continuationResponse._requestMetadata.closed === true) {
                  console.log('[SegmentAnalyzer] Conversación cerrada exitosamente después de', attemptCount, 'intentos');
                  isClosed = true;
                  
                  // Usar la respuesta final y salir del bucle
                  aiResponse = continuationResponse;
                } else {
                  console.log('[SegmentAnalyzer] La conversación aún no está cerrada, continuando el bucle');
                }
              } else {
                console.error('[SegmentAnalyzer] Respuesta de continuación inválida, intentando de nuevo');
              }
            } catch (continuationError) {
              console.error(`[SegmentAnalyzer] Error en intento ${attemptCount} al continuar conversación:`, continuationError);
              // No salir del bucle, intentar de nuevo si quedan intentos
            }
          }
          
          // Al salir del bucle, verificar los resultados
          if (isClosed) {
            console.log('[SegmentAnalyzer] Bucle de continuación completado con éxito');
          } else {
            console.warn('[SegmentAnalyzer] Máximo de intentos alcanzado sin cerrar la conversación');
            // Utilizar la última respuesta obtenida, aunque no esté marcada como cerrada
            aiResponse = continuationResponse;
          }
        }
      }
      
      // Verificar que la respuesta sea un objeto válido
      if (!aiResponse || typeof aiResponse !== 'object') {
        console.error('[SegmentAnalyzer] Invalid AI response format:', aiResponse);
        
        // Verificar si la respuesta es un string que podría ser un JSON incompleto
        if (typeof aiResponse === 'string' && isIncompleteJson(aiResponse)) {
          console.log('[SegmentAnalyzer] Detected incomplete JSON response, attempting to continue generation');
          
          // Usar un timeout aún mayor para la continuación
          const continuationTimeout = effectiveTimeout * 1.5; // 50% más de tiempo para la continuación
          console.log(`[SegmentAnalyzer] Using extended timeout for continuation: ${continuationTimeout}ms`);
          
          // Intentar continuar la generación del JSON incompleto
          console.log('[SegmentAnalyzer] Iniciando proceso de continuación de JSON...');
          const continuationResult = await continueJsonGeneration({
            incompleteJson: aiResponse,
            modelType: options.aiProvider,
            modelId: options.aiModel,
            siteUrl: options.url,
            includeScreenshot: options.includeScreenshot,
            timeout: continuationTimeout, // Usar un timeout aún mayor para la continuación
            maxRetries: 3
          });
          
          console.log('[SegmentAnalyzer] Proceso de continuación completado, verificando resultado...');
          
          if (continuationResult.success && continuationResult.completeJson) {
            console.log('[SegmentAnalyzer] Successfully completed JSON generation after', 
              continuationResult.retries, 'retries');
            aiResponse = continuationResult.completeJson;
            console.log('[SegmentAnalyzer] JSON completo obtenido, continuando con el procesamiento');
          } else {
            console.error('[SegmentAnalyzer] Failed to complete JSON generation:', 
              continuationResult.error);
            
            // Si no se pudo completar, intentar reparar el JSON
            console.log('[SegmentAnalyzer] Intentando reparar JSON incompleto...');
            const repairedJson = attemptJsonRepair(aiResponse);
            if (repairedJson) {
              console.log('[SegmentAnalyzer] Successfully repaired incomplete JSON');
              aiResponse = repairedJson;
            } else {
              console.log('[SegmentAnalyzer] No se pudo reparar el JSON, creando objeto de error');
              // Si no se pudo reparar, crear un objeto de error
              aiResponse = {
                segments: [{
                  id: `error-format-${Date.now()}`,
                  name: "Error de formato",
                  description: "La respuesta de la IA no tiene el formato esperado.",
                  summary: "Error de formato en la respuesta",
                  estimatedSize: "0",
                  targetAudience: "N/A",
                  language: "N/A",
                  createdInDatabase: false,
                  error: true,
                  errorDetails: {
                    message: "La respuesta de la IA no es un JSON válido",
                    rawResponse: aiResponse ? String(aiResponse).substring(0, 500) : "N/A"
                  }
                }]
              };
            }
          }
        } else {
          // Si no es un JSON incompleto, crear un objeto de error
          console.log('[SegmentAnalyzer] La respuesta no es un JSON incompleto, creando objeto de error');
          aiResponse = {
            segments: [{
              id: `error-format-${Date.now()}`,
              name: "Error de formato",
              description: "La respuesta de la IA no tiene el formato esperado.",
              summary: "Error de formato en la respuesta",
              estimatedSize: "0",
              targetAudience: "N/A",
              language: "N/A",
              createdInDatabase: false,
              error: true,
              errorDetails: {
                message: "La respuesta de la IA no es un JSON válido",
                rawResponse: aiResponse ? String(aiResponse).substring(0, 500) : "N/A"
              }
            }]
          };
        }
      } else {
        // Registrar la estructura de la respuesta para depuración
        console.log('[SegmentAnalyzer] AI response structure:', Object.keys(aiResponse));
        
        // Si la respuesta tiene una propiedad 'content', intentar extraer JSON
        if (aiResponse.content && typeof aiResponse.content === 'string') {
          console.log('[SegmentAnalyzer] Response has content property, attempting to parse as JSON');
          
          // Verificar si el contenido es un JSON incompleto
          if (isIncompleteJson(aiResponse.content)) {
            console.log('[SegmentAnalyzer] Detected incomplete JSON in content, attempting to continue generation');
            
            // Usar un timeout aún mayor para la continuación
            const continuationTimeout = effectiveTimeout * 1.5; // 50% más de tiempo para la continuación
            console.log(`[SegmentAnalyzer] Using extended timeout for continuation: ${continuationTimeout}ms`);
            
            // Intentar continuar la generación del JSON incompleto
            console.log('[SegmentAnalyzer] Iniciando proceso de continuación de JSON desde content...');
            const continuationResult = await continueJsonGeneration({
              incompleteJson: aiResponse.content,
              modelType: options.aiProvider,
              modelId: options.aiModel,
              siteUrl: options.url,
              includeScreenshot: options.includeScreenshot,
              timeout: continuationTimeout, // Usar un timeout aún mayor para la continuación
              maxRetries: 3
            });
            
            console.log('[SegmentAnalyzer] Proceso de continuación de content completado, verificando resultado...');
            
            if (continuationResult.success && continuationResult.completeJson) {
              console.log('[SegmentAnalyzer] Successfully completed JSON generation after', 
                continuationResult.retries, 'retries');
              aiResponse = continuationResult.completeJson;
              console.log('[SegmentAnalyzer] JSON completo obtenido desde content, continuando con el procesamiento');
            } else {
              console.error('[SegmentAnalyzer] Failed to complete JSON generation from content:', 
                continuationResult.error);
              
              // Intentar reparar el JSON incompleto
              console.log('[SegmentAnalyzer] Intentando reparar JSON incompleto desde content...');
              const repairedJson = attemptJsonRepair(aiResponse.content);
              if (repairedJson) {
                console.log('[SegmentAnalyzer] Successfully repaired incomplete JSON in content');
                aiResponse = repairedJson;
              } else {
                // Continuar con el proceso normal de análisis
                try {
                  // Intentar extraer JSON de la respuesta si está en formato markdown
                  console.log('[SegmentAnalyzer] Intentando extraer JSON de markdown en content...');
                  const jsonMatch = aiResponse.content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                  const jsonString = jsonMatch ? jsonMatch[1] : aiResponse.content;
                  
                  const parsedContent = JSON.parse(jsonString);
                  if (parsedContent && typeof parsedContent === 'object') {
                    console.log('[SegmentAnalyzer] Successfully parsed content as JSON');
                    aiResponse = parsedContent;
                  }
                } catch (parseError) {
                  console.log('[SegmentAnalyzer] Content is not valid JSON, continuing with original response');
                }
              }
            }
          } else {
            // Proceso normal para contenido JSON válido
            try {
              // Intentar extraer JSON de la respuesta si está en formato markdown
              console.log('[SegmentAnalyzer] Intentando extraer JSON de markdown en content válido...');
              const jsonMatch = aiResponse.content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
              const jsonString = jsonMatch ? jsonMatch[1] : aiResponse.content;
              
              const parsedContent = JSON.parse(jsonString);
              if (parsedContent && typeof parsedContent === 'object') {
                console.log('[SegmentAnalyzer] Successfully parsed content as JSON');
                aiResponse = parsedContent;
              }
            } catch (parseError) {
              console.log('[SegmentAnalyzer] Content is not valid JSON, continuing with original response');
            }
          }
        }
        
        // Si la respuesta tiene una propiedad 'choices', extraer el contenido del mensaje
        if (aiResponse.choices && Array.isArray(aiResponse.choices) && aiResponse.choices.length > 0) {
          console.log('[SegmentAnalyzer] Response has choices property');
          const messageContent = aiResponse.choices[0].message?.content;
          
          if (messageContent) {
            console.log('[SegmentAnalyzer] Found message content in choices');
            
            // Si el contenido es un string, verificar si es un JSON incompleto
            if (typeof messageContent === 'string') {
              if (isIncompleteJson(messageContent)) {
                console.log('[SegmentAnalyzer] Detected incomplete JSON in message content, attempting to continue generation');
                
                // Usar un timeout aún mayor para la continuación
                const continuationTimeout = effectiveTimeout * 1.5; // 50% más de tiempo para la continuación
                console.log(`[SegmentAnalyzer] Using extended timeout for continuation: ${continuationTimeout}ms`);
                
                // Intentar continuar la generación del JSON incompleto
                console.log('[SegmentAnalyzer] Iniciando proceso de continuación de JSON desde message content...');
                const continuationResult = await continueJsonGeneration({
                  incompleteJson: messageContent,
                  modelType: options.aiProvider,
                  modelId: options.aiModel,
                  siteUrl: options.url,
                  includeScreenshot: options.includeScreenshot,
                  timeout: continuationTimeout, // Usar un timeout aún mayor para la continuación
                  maxRetries: 3
                });
                
                console.log('[SegmentAnalyzer] Proceso de continuación de message content completado, verificando resultado...');
                
                if (continuationResult.success && continuationResult.completeJson) {
                  console.log('[SegmentAnalyzer] Successfully completed JSON generation after', 
                    continuationResult.retries, 'retries');
                  aiResponse = continuationResult.completeJson;
                  console.log('[SegmentAnalyzer] JSON completo obtenido desde message content, continuando con el procesamiento');
                } else {
                  console.error('[SegmentAnalyzer] Failed to complete JSON generation from message content:', 
                    continuationResult.error);
                  
                  // Intentar reparar el JSON incompleto
                  console.log('[SegmentAnalyzer] Intentando reparar JSON incompleto desde message content...');
                  const repairedJson = attemptJsonRepair(messageContent);
                  if (repairedJson) {
                    console.log('[SegmentAnalyzer] Successfully repaired incomplete JSON in message content');
                    aiResponse = repairedJson;
                  } else {
                    // Intentar extraer JSON de la respuesta si está en formato markdown
                    try {
                      console.log('[SegmentAnalyzer] Intentando extraer JSON de markdown en message content...');
                      const jsonMatch = messageContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                      if (jsonMatch) {
                        const parsedJson = JSON.parse(jsonMatch[1]);
                        console.log('[SegmentAnalyzer] Successfully extracted JSON from markdown in message content');
                        aiResponse = parsedJson;
                      } else {
                        console.log('[SegmentAnalyzer] No JSON found in markdown format, continuing with original response');
                      }
                    } catch (extractError) {
                      console.error('[SegmentAnalyzer] Failed to extract JSON from message content');
                    }
                  }
                }
              } else {
                // Intentar extraer JSON de la respuesta si está en formato markdown
                try {
                  console.log('[SegmentAnalyzer] Intentando extraer JSON de markdown en message content válido...');
                  const jsonMatch = messageContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                  if (jsonMatch) {
                    const parsedJson = JSON.parse(jsonMatch[1]);
                    console.log('[SegmentAnalyzer] Successfully extracted JSON from markdown in message content');
                    aiResponse = parsedJson;
                  } else {
                    // Intentar parsear directamente
                    try {
                      const parsedContent = JSON.parse(messageContent);
                      console.log('[SegmentAnalyzer] Successfully parsed message content as JSON');
                      aiResponse = parsedContent;
                    } catch (parseError) {
                      console.log('[SegmentAnalyzer] Message content is not valid JSON, continuing with original response');
                    }
                  }
                } catch (extractError) {
                  console.log('[SegmentAnalyzer] Failed to extract JSON from message content, continuing with original response');
                }
              }
            }
          }
        }
      }
    } catch (conversationError: any) {
      console.error('[SegmentAnalyzer] Error in conversation API:', conversationError);
      
      // Crear una respuesta de error estructurada
      return {
        segments: [{
          id: `api-error-${Date.now()}`,
          name: "Error en la API",
          description: `Error en la API de conversación: ${conversationError.message || 'Error desconocido'}`,
          summary: "Error al comunicarse con la IA",
          estimatedSize: "0",
          targetAudience: "N/A",
          language: "N/A",
          createdInDatabase: false,
          error: true,
          errorDetails: {
            message: `Error en la API de conversación: ${conversationError.message || 'Error desconocido'}`,
            affectedSegments: [],
            severity: "alta"
          }
        }],
        segmentsCreated: 0,
        segmentsUpdated: 0,
        siteContext: {},
        nextSteps: [],
        errors: [{
          code: "CONVERSATION_API_ERROR",
          message: `Error en la API de conversación: ${conversationError.message || 'Error desconocido'}`,
          affectedSegments: [],
          severity: "alta"
        }]
      };
    }
    
    // Procesar la respuesta
    console.log('[SegmentAnalyzer] Processing AI response');
    const segments = processAIResponse(aiResponse, options);
    console.log('[SegmentAnalyzer] Processed segments count:', segments.length);
    
    // Normalizar los segmentos
    console.log('[SegmentAnalyzer] Normalizing segments');
    const normalizedSegments = segments.map(segment => normalizeSegment(segment, options));
    console.log('[SegmentAnalyzer] Segments normalized');
    
    // Ya no filtramos por confidenceScore ya que lo hemos eliminado
    console.log('[SegmentAnalyzer] Skipping confidence score filtering as it has been removed');
    const filteredSegments = normalizedSegments;
    console.log('[SegmentAnalyzer] Segments count after processing:', filteredSegments.length);
    
    // Determinar el número de segmentos a limitar
    const segmentCountToUse = options.segmentCount;
    
    // Limitar el número de segmentos según el parámetro determinado
    console.log('[SegmentAnalyzer] Limiting segments to count:', segmentCountToUse);
    const limitedSegments = filteredSegments.slice(0, segmentCountToUse);
    
    // Crear o actualizar segmentos en la base de datos si es necesario
    let segmentsCreated = 0;
    let segmentsUpdated = 0;
    
    if (options.mode === 'create' || options.mode === 'update') {
      console.log('[SegmentAnalyzer] Mode requires database operations:', options.mode);
      
      for (const segment of limitedSegments) {
        try {
          if (options.mode === 'create') {
            console.log('[SegmentAnalyzer] Creating segment in database:', segment.id);
            try {
              // Extraer keywords y hot_topics del análisis si están disponibles
              const keywords = [];
              const hotTopics = [];
              
              // Intentar extraer keywords de diferentes fuentes en el segmento
              if (segment.attributes?.psychographic?.interests) {
                keywords.push(...(Array.isArray(segment.attributes.psychographic.interests) 
                  ? segment.attributes.psychographic.interests 
                  : [segment.attributes.psychographic.interests]));
              }
              
              if (segment.attributes?.behavioral?.topics) {
                hotTopics.push(...(Array.isArray(segment.attributes.behavioral.topics) 
                  ? segment.attributes.behavioral.topics 
                  : [segment.attributes.behavioral.topics]));
              }
              
              // Si hay audienceProfile con intereses, agregarlos a keywords
              if (segment.audienceProfile?.adPlatforms?.googleAds?.interests) {
                keywords.push(...(Array.isArray(segment.audienceProfile.adPlatforms.googleAds.interests) 
                  ? segment.audienceProfile.adPlatforms.googleAds.interests 
                  : [segment.audienceProfile.adPlatforms.googleAds.interests]));
              }
              
              // Preparar los datos del segmento para la base de datos
              const segmentData = {
                name: segment.name,
                description: segment.description,
                audience: Array.isArray(segment.targetAudience) ? segment.targetAudience.join(', ') : segment.targetAudience,
                size: parseFloat(segment.estimatedSize) || 0,
                estimated_value: segment.estimated_value || segment.size_value || "0",
                is_active: true,
                keywords: keywords.length > 0 ? keywords : [],
                hot_topics: hotTopics.length > 0 ? hotTopics : [],
                site_id: options.site_id || generateSegmentId(options.url),
                user_id: options.userId,
                language: segment.language,
                url: options.url
              };
              
              console.log('[SegmentAnalyzer] Segment data prepared for database:', JSON.stringify(segmentData));
              
              const result = await createSegmentInDatabase(segmentData);
              if (result && typeof result === 'object' && 'id' in result) {
                segment.createdInDatabase = true;
                segment.databaseId = result.id;
                segmentsCreated++;
                console.log('[SegmentAnalyzer] Segment created successfully:', segment.id);
              } else {
                console.error('[SegmentAnalyzer] Failed to create segment in database:', segment.id);
                segment.createdInDatabase = false;
              }
            } catch (dbError) {
              console.error('[SegmentAnalyzer] Error creating segment in database:', dbError);
              segment.createdInDatabase = false;
            }
          } else if (options.mode === 'update') {
            console.log('[SegmentAnalyzer] Finding similar segments for update');
            try {
              const similarSegments = await findSimilarSegments(
                options.userId,
                segment.name,
                options.url
              );
              
              if (similarSegments && Array.isArray(similarSegments) && similarSegments.length > 0) {
                console.log('[SegmentAnalyzer] Found similar segments:', similarSegments.length);
                const targetSegment = similarSegments[0];
                if (targetSegment && typeof targetSegment === 'object' && 'id' in targetSegment) {
                  console.log('[SegmentAnalyzer] Updating segment:', targetSegment.id);
                  
                  // Extraer keywords y hot_topics del análisis si están disponibles
                  const keywords = [];
                  const hotTopics = [];
                  
                  // Intentar extraer keywords de diferentes fuentes en el segmento
                  if (segment.attributes?.psychographic?.interests) {
                    keywords.push(...(Array.isArray(segment.attributes.psychographic.interests) 
                      ? segment.attributes.psychographic.interests 
                      : [segment.attributes.psychographic.interests]));
                  }
                  
                  if (segment.attributes?.behavioral?.topics) {
                    hotTopics.push(...(Array.isArray(segment.attributes.behavioral.topics) 
                      ? segment.attributes.behavioral.topics 
                      : [segment.attributes.behavioral.topics]));
                  }
                  
                  // Si hay audienceProfile con intereses, agregarlos a keywords
                  if (segment.audienceProfile?.adPlatforms?.googleAds?.interests) {
                    keywords.push(...(Array.isArray(segment.audienceProfile.adPlatforms.googleAds.interests) 
                      ? segment.audienceProfile.adPlatforms.googleAds.interests 
                      : [segment.audienceProfile.adPlatforms.googleAds.interests]));
                  }
                  
                  // Preparar los datos de actualización
                  const updates = {
                    name: segment.name,
                    description: segment.description,
                    audience: Array.isArray(segment.targetAudience) ? segment.targetAudience.join(', ') : segment.targetAudience,
                    size: parseFloat(segment.estimatedSize) || 0,
                    estimated_value: segment.estimated_value || segment.size_value || "0",
                    keywords: keywords.length > 0 ? keywords : undefined,
                    hot_topics: hotTopics.length > 0 ? hotTopics : undefined,
                    language: segment.language,
                    url: options.url
                  };
                  
                  console.log('[SegmentAnalyzer] Segment update data prepared:', JSON.stringify(updates));
                  
                  const result = await updateSegment(targetSegment.id, updates);
                  if (result) {
                    segment.createdInDatabase = true;
                    segment.databaseId = targetSegment.id;
                    segmentsUpdated++;
                    console.log('[SegmentAnalyzer] Segment updated successfully:', targetSegment.id);
                  } else {
                    console.error('[SegmentAnalyzer] Failed to update segment in database:', targetSegment.id);
                    segment.createdInDatabase = false;
                  }
                }
              } else {
                console.log('[SegmentAnalyzer] No similar segments found, creating new');
                // Extraer keywords y hot_topics del análisis si están disponibles
                const keywords = [];
                const hotTopics = [];
                
                // Intentar extraer keywords de diferentes fuentes en el segmento
                if (segment.attributes?.psychographic?.interests) {
                  keywords.push(...(Array.isArray(segment.attributes.psychographic.interests) 
                    ? segment.attributes.psychographic.interests 
                    : [segment.attributes.psychographic.interests]));
                }
                
                if (segment.attributes?.behavioral?.topics) {
                  hotTopics.push(...(Array.isArray(segment.attributes.behavioral.topics) 
                    ? segment.attributes.behavioral.topics 
                    : [segment.attributes.behavioral.topics]));
                }
                
                // Si hay audienceProfile con intereses, agregarlos a keywords
                if (segment.audienceProfile?.adPlatforms?.googleAds?.interests) {
                  keywords.push(...(Array.isArray(segment.audienceProfile.adPlatforms.googleAds.interests) 
                    ? segment.audienceProfile.adPlatforms.googleAds.interests 
                    : [segment.audienceProfile.adPlatforms.googleAds.interests]));
                }
                
                // Preparar los datos del segmento para la base de datos
                const segmentData = {
                  name: segment.name,
                  description: segment.description,
                  audience: Array.isArray(segment.targetAudience) ? segment.targetAudience.join(', ') : segment.targetAudience,
                  size: parseFloat(segment.estimatedSize) || 0,
                  estimated_value: segment.estimated_value || segment.size_value || "0",
                  is_active: true,
                  keywords: keywords.length > 0 ? keywords : [],
                  hot_topics: hotTopics.length > 0 ? hotTopics : [],
                  site_id: options.site_id || generateSegmentId(options.url),
                  user_id: options.userId,
                  language: segment.language,
                  url: options.url
                };
                
                console.log('[SegmentAnalyzer] New segment data prepared for database:', JSON.stringify(segmentData));
                
                const result = await createSegmentInDatabase(segmentData);
                if (result && typeof result === 'object' && 'id' in result) {
                  segment.createdInDatabase = true;
                  segment.databaseId = result.id;
                  segmentsCreated++;
                  console.log('[SegmentAnalyzer] New segment created:', segment.id);
                } else {
                  console.error('[SegmentAnalyzer] Failed to create new segment in database:', segment.id);
                  segment.createdInDatabase = false;
                }
              }
            } catch (dbError) {
              console.error('[SegmentAnalyzer] Error in database operation:', dbError);
              segment.createdInDatabase = false;
            }
          }
        } catch (error) {
          console.error('[SegmentAnalyzer] Error in database operation:', error);
        }
      }
    }
    
    // Ya no calculamos confidenceOverall basado en confidenceScore ya que lo hemos eliminado
    console.log('[SegmentAnalyzer] Setting default confidenceOverall value');
    const confidenceOverall = 0.5; // Valor por defecto
    
    console.log('[SegmentAnalyzer] Analysis completed successfully');
    return {
      segments: limitedSegments,
      segmentsCreated,
      segmentsUpdated,
      siteContext: aiResponse.siteContext,
      confidenceOverall,
      nextSteps: aiResponse.nextSteps,
      errors: aiResponse.errors
    };
  } catch (error: any) {
    console.error('Error al analizar segmentos:', error);
    return {
      segments: [{
        id: `internal-error-${Date.now()}`,
        name: "Error interno",
        description: "Error al analizar segmentos",
        summary: "Error al analizar segmentos",
        estimatedSize: "0",
        targetAudience: "N/A",
        language: "N/A",
        createdInDatabase: false,
        error: true,
        errorDetails: {
          message: "Error al analizar segmentos",
          rawResponse: typeof error === 'object' ? JSON.stringify(error) : String(error)
        }
      }],
      segmentsCreated: 0,
      segmentsUpdated: 0,
    };
  }
}

/**
 * Prepara el prompt para el análisis de segmentos
 * 
 * @param options Opciones de análisis de segmentos
 * @returns Prompt para el análisis de segmentos
 */
function prepareSegmentAnalysisPrompt(options: SegmentAnalysisOptions): string {
  // Determine the number of segments to generate
  const segmentCountToUse = options.segmentCount;
  
  // Build the base prompt
  let prompt = `Analyze the website ${options.url} and identify the ${segmentCountToUse} most profitable audience segments.

For each segment, provide:
- A descriptive name
- A detailed description
- A concise summary of the segment
- Estimated SAM size by segment, refined by the target audience in the region and language (units)
- Estimated SAM Market value by segment, refined by the target audience in the region and language (USD)
- Target audience
- Audience profile
- Language
- Attributes (demographic, behavioral, etc.)

IMPORTANT: Your response MUST be a valid JSON object with the following structure:

{
  "url": "${options.url}",
  "segmentsAnalyzed": ${segmentCountToUse},
  "segments": [
    {
      "name": "Digital Content Creators",
      "description": "Professionals and enthusiasts aged 20-40 dedicated to creating digital content for social media and online platforms",
      "summary": "Highly profitable segment of digital creators with specific needs for professional tools and willingness to invest in solutions that improve their creative workflow.",
      "targetAudience": "media_entertainment",
      "size": "189,000",
      "estimated_value": "9,000,000",      
      "audienceProfile": {
        "adPlatforms": {
          "googleAds": {
            "demographics": {
              "ageRanges": ["25-34", "35-44"],
              "gender": ["male", "female"],
              "parentalStatus": ["parent"],
              "householdIncome": ["top 10%", "top 20%"]
            },
            "interests": [
              "Digital Content Creation",
              "Video Production",
              "Photography",
              "Graphic Design",
              "Technology Early Adopters"
            ],
            "inMarketSegments": [
              "Software",
              "Creative Software",
              "Video Editing Software",
              "Photography Equipment",
              "Computer Hardware"
            ],
            "locations": [
              "United States",
              "Canada",
              "United Kingdom",
              "Australia"
            ],
            "geoTargeting": {
              "countries": ["US", "CA", "UK", "AU"],
              "regions": ["California", "New York", "Texas", "Ontario", "London"],
              "cities": ["San Francisco", "New York", "Los Angeles", "Toronto", "London"]
            }
          },
          "facebookAds": {
            "demographics": {
              "age": [25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
              "education": ["College grad", "In grad school", "Master's degree"],
              "generation": ["Millennials", "Gen Z"]
            },
            "interests": [
              "Adobe Creative Cloud",
              "Content creation",
              "Digital marketing",
              "Video production",
              "Photography"
            ],
            "locations": {
              "countries": ["United States", "Canada", "United Kingdom", "Australia"],
              "regions": ["California", "New York", "Texas", "Florida", "Illinois"],
              "cities": ["Los Angeles", "New York", "Chicago", "Toronto", "London"],
              "zips": ["90210", "10001", "60601", "M5V", "SW1A"]
            },
            "languages": ["English"]
          },
          "linkedInAds": {
            "demographics": {
              "age": ["25-34", "35-54"],
              "education": ["Bachelor's Degree", "Master's Degree"],
              "jobExperience": ["Mid-Senior level", "Director"]
            },
            "jobTitles": [
              "Creative Director",
              "Content Producer",
              "Digital Marketing Manager",
              "Graphic Designer",
              "Video Editor"
            ],
            "industries": [
              "Marketing and Advertising",
              "Media Production",
              "Design",
              "Information Technology"
            ],
            "companySize": ["11-50", "51-200", "201-500"],
            "locations": {
              "countries": ["United States", "Canada", "United Kingdom", "Australia"],
              "regions": ["West Coast", "East Coast", "Midwest", "Southeast"],
              "metropolitanAreas": ["San Francisco Bay Area", "Greater New York City Area", "Greater Los Angeles Area"]
            }
          },
          "tiktokAds": {
            "demographics": {
              "age": ["18-24", "25-34"],
              "gender": ["male", "female"],
              "location": ["Urban areas", "Creative hubs"]
            },
            "interests": [
              "Content Creation",
              "Video Editing",
              "Creative Tools",
              "Digital Art",
              "Tech Gadgets"
            ],
            "behaviors": [
              "App installs: Creative tools",
              "Engagement: Tutorial videos",
              "Shopping: Tech accessories",
              "Creator economy participants"
            ],
            "creatorCategories": [
              "Tech Reviewers",
              "Digital Artists",
              "Tutorial Creators",
              "Productivity Influencers"
            ],
            "locations": {
              "countries": ["United States", "Canada", "United Kingdom", "Australia"],
              "regions": ["California", "New York", "Texas", "Ontario", "London"],
              "cities": ["Los Angeles", "New York", "Miami", "Toronto", "London"]
            },
            "languages": ["English"]
          }
        }
      },
      "language": "en",
}

Make sure your response is a valid JSON and follows this structure exactly. Do not include additional explanations outside the JSON. Replace the example data with real information based on your analysis of the website.

IMPORTANT: Each segment must have EXACTLY ONE language specified in the "language" field. All countries and regions listed in the segment's audience profile MUST primarily speak the language specified for that segment. Do not include countries or regions that primarily speak a different language than the one specified for the segment. For example, if a segment has "language": "en", only include English-speaking countries and regions in the locations.`;

  // Add audience list options
  prompt += `\n\nFor the targetAudience field, please select from the following options:
enterprise
smb
startup
b2b_saas
e_commerce
tech
finance
healthcare
education
manufacturing
retail
real_estate
hospitality
automotive
media
telecom
energy
agriculture
construction
logistics
professional
government
nonprofit
legal
pharma
insurance
consulting
research
aerospace
gaming`;

  // Add profitability metrics if specified
  if (options.profitabilityMetrics && options.profitabilityMetrics.length > 0) {
    prompt += `\n\nEvaluate profitability based on these specific metrics: ${options.profitabilityMetrics.join(', ')}.`;
  }

  // Add segment attributes if specified
  if (options.segmentAttributes && options.segmentAttributes.length > 0) {
    prompt += `\n\nInclude these specific attributes for each segment: ${options.segmentAttributes.join(', ')}.`;
  }

  // Add industry context if specified
  if (options.industryContext) {
    prompt += `\n\nPlease note that this site belongs to the industry: ${options.industryContext}.`;
  }

  // Add additional instructions if specified
  if (options.additionalInstructions) {
    prompt += `\n\n${options.additionalInstructions}`;
  }

  // Add instructions for the mode
  if (options.mode === 'create') {
    prompt += `\n\nThese segments will be created in the database, so make sure they are accurate and useful.`;
  } else if (options.mode === 'update') {
    prompt += `\n\nThese segments will be used to update existing segments in the database.`;
  }

  return prompt;
}

/**
 * Procesa la respuesta de la IA para extraer los segmentos
 * 
 * @param aiResponse Respuesta de la IA
 * @param options Opciones de análisis de segmentos
 * @returns Array de segmentos procesados
 */
function processAIResponse(aiResponse: any, options: SegmentAnalysisOptions): any[] {
  console.log('[SegmentAnalyzer] Processing AI response');
  
  // Verificar si la respuesta es un string (posiblemente JSON)
  if (typeof aiResponse === 'string') {
    console.log('[SegmentAnalyzer] AI response is a string, attempting to parse as JSON');
    try {
      aiResponse = JSON.parse(aiResponse);
    } catch (error) {
      console.error('[SegmentAnalyzer] Failed to parse AI response as JSON:', error);
      return [{
        id: `parse-error-${Date.now()}`,
        name: "Error de formato",
        description: "La respuesta de la IA no es un JSON válido.",
        summary: "Error al procesar la respuesta de la IA",
        estimatedSize: "0",
        targetAudience: "N/A",
        language: "N/A",
        createdInDatabase: false,
        error: true,
        errorDetails: {
          message: "La respuesta de la IA no es un JSON válido",
          rawResponse: aiResponse.substring(0, 500) + (aiResponse.length > 500 ? '...' : '')
        }
      }];
    }
  }
  
  // Verificar si la respuesta está dentro de un objeto "Assistant" o similar
  if (aiResponse && typeof aiResponse === 'object') {
    console.log('[SegmentAnalyzer] Checking for nested response structure');
    
    // Verificar si hay una propiedad que contiene un objeto con segments
    for (const key in aiResponse) {
      if (aiResponse[key] && 
          typeof aiResponse[key] === 'object' && 
          aiResponse[key].segments && 
          Array.isArray(aiResponse[key].segments)) {
        console.log(`[SegmentAnalyzer] Found segments in nested property: ${key}`);
        aiResponse = aiResponse[key];
        break;
      }
    }
    
    // Verificar si hay una propiedad "content" que podría contener JSON
    if (aiResponse.content && typeof aiResponse.content === 'string') {
      console.log('[SegmentAnalyzer] Found content property, attempting to parse as JSON');
      try {
        const parsedContent = JSON.parse(aiResponse.content);
        if (parsedContent && typeof parsedContent === 'object' && parsedContent.segments) {
          console.log('[SegmentAnalyzer] Successfully parsed content as JSON with segments');
          aiResponse = parsedContent;
        }
      } catch (error) {
        console.log('[SegmentAnalyzer] Content is not valid JSON, continuing with original response');
      }
    }
  }
  
  // Verificar si la respuesta contiene segmentos
  if (!aiResponse || !aiResponse.segments || !Array.isArray(aiResponse.segments)) {
    console.error('[SegmentAnalyzer] AI response does not contain segments', aiResponse);
    
    // Crear un segmento de error para asegurar que siempre devolvemos algo válido
    return [{
      id: `error-segment-${Date.now()}`,
      name: "Error en el análisis",
      description: "No se pudieron identificar segmentos válidos en la respuesta de la IA.",
      summary: "Error en el análisis de segmentos",
      estimatedSize: "0",
      targetAudience: "N/A",
      language: "N/A",
      createdInDatabase: false,
      error: true,
      errorDetails: {
        message: "La respuesta de la IA no contiene segmentos válidos",
        rawResponse: typeof aiResponse === 'object' ? JSON.stringify(aiResponse).substring(0, 500) : String(aiResponse).substring(0, 500)
      }
    }];
  }
  
  // Extraer los segmentos de la respuesta
  const segments = aiResponse.segments;
  console.log(`[SegmentAnalyzer] Found ${segments.length} segments in AI response`);
  
  // Verificar que cada segmento tenga los campos requeridos
  const validSegments = segments.filter((segment: any) => {
    const hasRequiredFields = 
      segment.name && 
      segment.description;
    
    if (!hasRequiredFields) {
      console.warn('[SegmentAnalyzer] Segment missing required fields:', segment);
    }
    
    return hasRequiredFields;
  });
  
  console.log(`[SegmentAnalyzer] Found ${validSegments.length} valid segments out of ${segments.length}`);
  
  // Si no hay segmentos válidos, devolver un segmento de error
  if (validSegments.length === 0 && segments.length > 0) {
    return [{
      id: `incomplete-segment-${Date.now()}`,
      name: "Segmentos incompletos",
      description: "Los segmentos identificados no contienen todos los campos requeridos.",
      summary: "Segmentos con datos incompletos",
      estimatedSize: "0",
      targetAudience: "N/A",
      language: "N/A",
      createdInDatabase: false,
      error: true,
      errorDetails: {
        message: "Ninguno de los segmentos contiene todos los campos requeridos",
        segmentsCount: segments.length,
        firstSegmentSample: segments[0] ? JSON.stringify(segments[0]) : "N/A"
      }
    }];
  }
  
  return validSegments;
}

/**
 * Normaliza un segmento para asegurar que tenga todos los campos requeridos
 * 
 * @param segment Segmento a normalizar
 * @param options Opciones de análisis de segmentos
 * @returns Segmento normalizado
 */
function normalizeSegment(segment: any, options: SegmentAnalysisOptions): any {
  // Si es un segmento de error, preservar sus propiedades de error
  if (segment.error) {
    return {
      ...segment,
      createdInDatabase: false
    };
  }
  
  // Asegurarse de que el segmento tenga un ID
  if (!segment.id) {
    segment.id = generateSegmentId(segment.name);
  }
  
  // Eliminar las puntuaciones de rentabilidad y confianza ya que no se utilizan
  if (segment.profitabilityScore !== undefined) {
    delete segment.profitabilityScore;
  }
  
  if (segment.confidenceScore !== undefined) {
    delete segment.confidenceScore;
  }
  
  // Asegurarse de que el segmento tenga un tamaño estimado
  // Usar el campo size si está disponible
  if (!segment.estimatedSize) {
    if (segment.size) {
      segment.estimatedSize = String(segment.size);
    } else {
      segment.estimatedSize = "0"; // Valor por defecto
    }
  }
  
  // Asegurarse de que el segmento tenga un valor estimado
  // Usar el campo estimated_value si está disponible, o size_value como alternativa
  if (!segment.estimated_value) {
    if (segment.size_value) {
      segment.estimated_value = String(segment.size_value);
    } else {
      segment.estimated_value = "0"; // Valor por defecto
    }
  }
  
  // Asegurarse de que el segmento tenga un idioma
  if (!segment.language) {
    segment.language = "en"; // Valor por defecto
  }
  
  // Asegurarse de que el segmento tenga una audiencia objetivo
  if (!segment.targetAudience) {
    segment.targetAudience = "general"; // Valor por defecto
  }
  
  // Asegurarse de que el segmento tenga un resumen
  if (!segment.summary) {
    segment.summary = segment.description.substring(0, 100) + "..."; // Generar un resumen a partir de la descripción
  }
  
  // Inicializar el estado de creación en la base de datos
  segment.createdInDatabase = false;
  
  
  return segment;
} 