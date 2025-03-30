/**
 * Functions for processing personalizations and formatting responses
 */
import { 
  PersonalizationModification, 
  PersonalizationOptions, 
  PersonalizationResponse,
  PersonalizationImplementation
} from './types';
import { logError } from '@/lib/utils/api-response-utils';
import { generateImplementationCode } from '../static-implementation-service';
import {
  generateUniqueId,
  determineAfterHtml,
  generatePersonalizationId,
  generatePreviewUrl,
  filterOptions,
  determineImplementationMethod,
  logPersonalizationsInfo
} from './utils';

/**
 * Asegura que las personalizaciones tengan el formato correcto
 */
export function ensurePersonalizations(personalizations: any[]): PersonalizationModification[] {
  if (!Array.isArray(personalizations)) {
    return [];
  }
  
  return personalizations.map((p: any, index: number) => {
    // Only log if after_html exists but has issues
    const hasAfterHtml = p.after_html !== undefined && p.after_html !== null;
    if (hasAfterHtml && typeof p.after_html !== 'string') {
      logError('HTML Personalization', 
        `Personalization #${index} (${p.selector || 'unknown'}): after_html has invalid type: ${typeof p.after_html}`
      );
    }
    
    // Determine after_html based on operation_type
    const afterHtml = determineAfterHtml(p);
    
    // Create standardized personalization object
    return {
      id: p.id || generatePersonalizationId(index),
      selector: p.selector || 'body',
      operation_type: p.operation_type || 'replace',
      after_html: afterHtml,
      before_html: p.before_html
    };
  });
}

/**
 * Enriquece las personalizaciones con el HTML original de cada elemento
 */
export function enrichPersonalizationsWithOriginalHtml(
  personalizations: PersonalizationModification[],
  originalAnalysis: any
): PersonalizationModification[] {
  console.log('[HTML Personalization] Enriqueciendo personalizaciones con HTML original');
  
  // Buscar en los bloques del análisis original
  const blocks = originalAnalysis.blocks || [];
  
  return personalizations.map(personalization => {
    // Buscar el elemento en los bloques del análisis original
    const originalBlock = blocks.find((block: any) => {
      // Buscar en el bloque principal
      if (block.selector === personalization.selector) {
        return true;
      }
      
      // Buscar en los content_blocks del bloque
      const contentBlocks = block.content_blocks || [];
      return contentBlocks.some((contentBlock: any) => 
        contentBlock.selector === personalization.selector
      );
    });
    
    if (originalBlock) {
      console.log(`[HTML Personalization] Encontrado HTML original para selector: ${personalization.selector}`);
      return {
        ...personalization,
        before_html: originalBlock.html || originalBlock.content
      };
    }
    
    console.log(`[HTML Personalization] No se encontró HTML original para selector: ${personalization.selector}`);
    return personalization;
  });
}

/**
 * Processes personalizations and generates implementation code
 */
export function processPersonalizations(
  personalizations: PersonalizationModification[],
  implementationMethod?: string,
  minifiedCode?: boolean
): { 
  responsePersonalizations: PersonalizationModification[], 
  implementationCode: PersonalizationImplementation 
} {
  // Create a copy for implementation code generation
  const personalizationsWithHtml = [...personalizations];
  
  // Format response personalizations but PRESERVE after_html exactly as received
  const responsePersonalizations = personalizations.map(p => {
    const formatted = {
      ...p,
      id: p.id || generateUniqueId(),
      // Ensure after_html is preserved exactly as is
      after_html: p.after_html
    };
    
    // Remove before_html to reduce size
    if ('before_html' in formatted) {
      delete formatted.before_html;
    }
    
    return formatted;
  });

  // Log HTML content for debugging
  logPersonalizationsInfo(responsePersonalizations);

  // Determine implementation method type
  const implementationMethodType = determineImplementationMethod(implementationMethod);
  
  // Default to minified code if option is set, otherwise use non-minified
  const useMinifiedCode = minifiedCode !== undefined ? minifiedCode : true;
  
  // Generate the implementation code
  const implementationCode = generateImplementationCode(
    personalizationsWithHtml,
    implementationMethodType,
    useMinifiedCode
  );
  
  return { responsePersonalizations, implementationCode };
}

/**
 * Creates the analysis metadata object
 */
export function createAnalysisMetadata(
  result: any,
  options: PersonalizationOptions,
  duration: number,
  redisStorageResult?: boolean
): any {
  const metadata: any = {
    modelUsed: result.model || options.aiModel || 'unknown',
    aiProvider: options.aiProvider || 'unknown',
    processingTime: `${duration.toFixed(2)} seconds`,
    segmentDataSource: options.site_id || 'default',
    siteScanDate: new Date().toISOString(),
    status: result.status || 'success',
    personalizationStrategy: result.strategy || 'adaptive_content_and_ui',
    minifiedCode: options.minified_code !== undefined ? options.minified_code : true
  };
  
  // Add storage information to the response if site_id is provided
  if (options.site_id !== undefined) {
    // Default to successful storage if redisStorageResult is true or undefined
    const storageSuccess = redisStorageResult !== false;
    
    metadata.storage = {
      cached: storageSuccess,
      cacheSuccess: storageSuccess,
      timestamp: new Date().toISOString()
    };
  }
  
  return metadata;
}

/**
 * Builds the complete personalization response
 */
export function buildPersonalizationResponse(
  url: string,
  segmentId: string,
  personalizationId: string,
  personalizations: PersonalizationModification[],
  implementationCode: PersonalizationImplementation,
  result: any,
  options: PersonalizationOptions,
  duration: number,
  redisStorageResult?: boolean
): PersonalizationResponse {
  // Prepare additional response components
  const previewUrl = options.include_preview 
    ? generatePreviewUrl(url, segmentId, personalizationId)
    : undefined;
  
  // Prepare analysis metadata
  const analysisMetadata = createAnalysisMetadata(result, options, duration, redisStorageResult);

  // Create a copy of options without the htmlContent field to reduce response size
  const filteredOptions = filterOptions(options);

  // Build the complete response
  return {
    url,
    segment_id: segmentId,
    personalization_id: personalizationId,
    personalizations,
    implementation_code: implementationCode,
    preview_url: previewUrl,
    metadata: {
      request: {
        timestamp: new Date().toISOString(),
        parameters: {
          url,
          segment_id: segmentId,
          ...filteredOptions
        }
      },
      analysis: analysisMetadata
    }
  };
}

/**
 * Formats the response of the personalization process
 */
export function formatPersonalizationResponse(
  url: string,
  segmentId: string,
  result: any,
  options: PersonalizationOptions,
  duration: number,
  redisStorageResult?: boolean
): PersonalizationResponse {
  // Generate a unique ID for the personalization
  const personalizationId = generateUniqueId();
  
  // Ensure personalizations array exists and has proper format
  const formattedPersonalizations = ensurePersonalizations(result.personalizations || []);
  
  // Log formatted personalizations information
  logPersonalizationsInfo(formattedPersonalizations);
  
  // Process the personalizations and implementation code
  const { responsePersonalizations, implementationCode } = processPersonalizations(
    formattedPersonalizations, 
    options.implementation_method,
    options.minified_code
  );

  // Prepare the final response
  return buildPersonalizationResponse(
    url,
    segmentId,
    personalizationId,
    responsePersonalizations,
    implementationCode,
    result,
    options,
    duration,
    redisStorageResult
  );
} 