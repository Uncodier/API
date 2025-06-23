/**
 * HTML Personalization Service
 * 
 * Este servicio proporciona funcionalidades para personalizar el contenido HTML
 * basado en segmentos de audiencia específicos.
 */

import { analyzeWithConversationApi } from '../conversation-client';
import { isIncompleteJson, continueJsonGeneration, attemptJsonRepair } from '../continuation-service';
import { getSegmentById } from '../segment-service';
import { savePersonalizationToRedis } from '../personalization-cache-service';
import { logError, logInfo } from '@/lib/utils/api-response-utils';

import {
  PersonalizationOptions,
  PersonalizationModification,
  PersonalizationImplementation,
  PersonalizationResponse
} from './types';

import {
  generatePersonalizationPrompt
} from './prompt-generator';

import {
  ensurePersonalizations,
  enrichPersonalizationsWithOriginalHtml,
  processPersonalizations,
  createAnalysisMetadata,
  buildPersonalizationResponse,
  formatPersonalizationResponse
} from './personalization-processor';

// Re-export types with 'export type'
export type {
  PersonalizationOptions,
  PersonalizationModification,
  PersonalizationImplementation,
  PersonalizationResponse
};

// Export functions
export {
  personalizeHtmlForSegment
};

// Exportar las nuevas funciones de generación segura de código
export { 
  generateSafeJavaScriptImplementation, 
  sanitizeExistingCode 
} from './safe-code-generator';

type AIProvider = 'openai' | 'anthropic' | 'gemini';

function isValidAIProvider(provider: string | undefined): provider is AIProvider {
  return provider === 'openai' || provider === 'anthropic' || provider === 'gemini';
}

/**
 * Genera personalizaciones de HTML basadas en un segmento específico
 * 
 * @param url URL del sitio a personalizar
 * @param segmentId ID del segmento para el que se personalizará el HTML
 * @param options Opciones de personalización
 * @returns Respuesta con las personalizaciones generadas
 */
async function personalizeHtmlForSegment(
  url: string,
  segmentId: string,
  options: PersonalizationOptions = {}
): Promise<PersonalizationResponse> {
  logInfo('HTML Personalization', `Iniciando personalización para URL: ${url}, Segmento: ${segmentId}`);
  
  try {
    // Configurar opciones por defecto
    const personalizeOptions = {
      timeout: options.timeout || 45000,
      userAgent: options.userAgent || 'Mozilla/5.0 (compatible; SiteAnalyzer/1.0)',
      personalization_level: options.personalization_level || 'moderate',
      target_elements: options.target_elements || ['all'],
      implementation_method: options.implementation_method || 'js_injection',
      device_type: options.device_type || 'all',
      aiProvider: options.aiProvider || 'anthropic',
      aiModel: options.aiModel || 'claude-3-5-sonnet-20240620',
      include_preview: options.include_preview !== undefined ? options.include_preview : true,
      include_diff: options.include_diff !== undefined ? options.include_diff : true,
      include_performance_impact: options.include_performance_impact !== undefined ? options.include_performance_impact : true,
      includeScreenshot: options.includeScreenshot !== undefined ? options.includeScreenshot : true,
      test_mode: options.test_mode !== undefined ? options.test_mode : true,
      user_id: options.user_id,
      site_id: options.site_id || 'default',
      target_pages: options.target_pages || [],
      htmlContent: options.htmlContent,
      screenshot: options.screenshot,
      originalAnalysis: options.originalAnalysis,
      redis_ttl: options.redis_ttl,
      minified_code: options.minified_code !== undefined ? options.minified_code : true
    };
    
    logInfo('HTML Personalization', `Opciones configuradas: ${JSON.stringify({
      personalization_level: personalizeOptions.personalization_level,
      target_elements: personalizeOptions.target_elements,
      implementation_method: personalizeOptions.implementation_method,
      aiProvider: personalizeOptions.aiProvider,
      aiModel: personalizeOptions.aiModel,
    })}`);
    
    // Obtener información del segmento
    const segment = await getSegmentById(segmentId);
    
    if (!segment) {
      throw new Error(`Segmento no encontrado: ${segmentId}`);
    }
    
    // Preparar prompt para la API de conversación
    const prompt = generatePersonalizationPrompt(
      url,
      segment,
      personalizeOptions
    );
    
    // Iniciar tiempo para medir duración
    const startTime = Date.now();
    
    // Aumentar el timeout para respuestas grandes
    const effectiveTimeout = Math.max(personalizeOptions.timeout || 45000, 120000);
    
    // Modificar la función analyzeWithConversationApi para manejar tipos indefinidos
    const aiProvider: AIProvider = isValidAIProvider(personalizeOptions.aiProvider) 
      ? personalizeOptions.aiProvider 
      : 'anthropic';

    const aiModel: string = personalizeOptions.aiModel || 'claude-3-5-sonnet-20240620';

    let result = await analyzeWithConversationApi(
      prompt,
      aiProvider,
      aiModel,
      url,
      personalizeOptions.includeScreenshot,
      effectiveTimeout,
      false,
      true,
      undefined
    );
    
    // Variable para rastrear si ya se manejó la continuación de JSON
    let jsonContinuationHandled = false;
    
    // Verificar si la respuesta tiene metadatos y si la conversación está cerrada
    if (result && typeof result === 'object' && result._requestMetadata) {
      if (result._requestMetadata.closed === false && result._requestMetadata.conversationId) {
        jsonContinuationHandled = true;
        result = await handleConversationContinuation(result, personalizeOptions, url, effectiveTimeout);
      }
    }
    
    // Manejar posible JSON incompleto si no se ha manejado ya
    if (!jsonContinuationHandled) {
      result = await handleIncompleteJson(result, personalizeOptions, url, effectiveTimeout);
    }
    
    // Enriquecer personalizaciones con HTML original si tenemos el análisis
    if (options.originalAnalysis && result.personalizations) {
      result.personalizations = enrichPersonalizationsWithOriginalHtml(
        result.personalizations,
        options.originalAnalysis
      );
    }
    
    // Calcular duración
    const duration = (Date.now() - startTime) / 1000;
    
    // Store the result in Redis if site_id is provided
    let redisStorageResult: boolean | undefined = undefined;
    
    if (personalizeOptions.site_id && result.personalizations?.length > 0) {
      const ttl = personalizeOptions.redis_ttl ? parseInt(personalizeOptions.redis_ttl, 10) : 86400;
      
      try {
        const formattedResult = formatPersonalizationResponse(
          url,
          segmentId,
          result,
          personalizeOptions,
          duration
        );
        
        redisStorageResult = await savePersonalizationToRedis(formattedResult, ttl);
      } catch (redisError) {
        logError('HTML Personalization', 'Error al guardar en Redis:', redisError);
        redisStorageResult = false;
      }
    }
    
    // Format and return the final response
    return formatPersonalizationResponse(
      url,
      segmentId,
      result,
      personalizeOptions,
      duration,
      redisStorageResult
    );
  } catch (error: any) {
    logError('HTML Personalization', 'Error al generar personalizaciones:', error);
    throw new Error(`Error al personalizar HTML: ${error.message}`);
  }
}

/**
 * Maneja la continuación de una conversación incompleta
 */
async function handleConversationContinuation(
  result: any,
  options: PersonalizationOptions,
  url: string,
  effectiveTimeout: number
): Promise<any> {
  const conversationId = result._requestMetadata.conversationId;
  let isClosed = false;
  let continuationResponse = result;
  let maxAttempts = 5;
  let attemptCount = 0;
  
  while (!isClosed && attemptCount < maxAttempts) {
    attemptCount++;
    const continuationTimeout = effectiveTimeout * (1.5 + (attemptCount * 0.1));
    
    try {
      await new Promise(resolve => setTimeout(resolve, 1000 * attemptCount));
      
      const continuationAiProvider: AIProvider = isValidAIProvider(options.aiProvider)
        ? options.aiProvider
        : 'anthropic';

      const continuationAiModel: string = options.aiModel || 'claude-3-5-sonnet-20240620';

      const response = await analyzeWithConversationApi(
        'Please continue exactly where you left off and complete the JSON response.',
        continuationAiProvider,
        continuationAiModel,
        url,
        options.includeScreenshot,
        continuationTimeout,
        false,
        true,
        conversationId
      );
      
      if (response && typeof response === 'object') {
        continuationResponse = response;
        
        if (continuationResponse._requestMetadata?.closed === true) {
          isClosed = true;
          return continuationResponse;
        }
      }
    } catch (continuationError) {
      logError('HTML Personalization', `Error en intento ${attemptCount}:`, continuationError);
    }
  }
  
  return continuationResponse;
}

/**
 * Maneja el procesamiento de JSON incompleto
 */
async function handleIncompleteJson(
  result: any,
  options: PersonalizationOptions,
  url: string,
  effectiveTimeout: number
): Promise<any> {
  if (typeof result === 'string') {
    const isNearTokenLimit = result.length > 80000;
    const isJsonIncomplete = isIncompleteJson(result);
    
    // Determinar el proveedor de AI y modelo
    const aiProvider: AIProvider = isValidAIProvider(options.aiProvider) 
      ? options.aiProvider 
      : 'anthropic';
    const aiModel: string = options.aiModel || 'claude-3-5-sonnet-20240620';
    
    if (isNearTokenLimit && isJsonIncomplete) {
      const continuationTimeout = effectiveTimeout * 1.5;
      
      const continuationResult = await continueJsonGeneration({
        incompleteJson: result,
        modelType: aiProvider,
        modelId: aiModel,
        siteUrl: url,
        includeScreenshot: options.includeScreenshot,
        timeout: continuationTimeout,
        maxRetries: 3
      });
      
      if (continuationResult.success && continuationResult.completeJson) {
        return continuationResult.completeJson;
      }
      
      const repairedJson = attemptJsonRepair(result);
      if (repairedJson) return repairedJson;
      
      throw new Error(`Error al completar JSON: ${continuationResult.error}`);
    }
    
    if (isJsonIncomplete) {
      const repairedJson = attemptJsonRepair(result);
      if (repairedJson) return repairedJson;
      
      const continuationResult = await continueJsonGeneration({
        incompleteJson: result,
        modelType: aiProvider,
        modelId: aiModel,
        siteUrl: url,
        includeScreenshot: options.includeScreenshot,
        timeout: effectiveTimeout * 1.5,
        maxRetries: 3
      });
      
      if (continuationResult.success && continuationResult.completeJson) {
        return continuationResult.completeJson;
      }
      
      throw new Error(`Error al completar JSON: ${continuationResult.error}`);
    }
    
    try {
      return JSON.parse(result);
    } catch (parseError) {
      const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
      throw new Error('No se pudo procesar la respuesta de la API: formato no reconocido');
    }
  }
  
  return result;
} 