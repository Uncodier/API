import { getRedisClient, waitForRedis } from '@/lib/utils/redis-client';
import { PersonalizationResponse, PersonalizationModification } from './html-personalization-service';
import { generateImplementationCode } from './static-implementation-service';
import { logInfo, logError, logDebug } from '@/lib/utils/api-response-utils';

/**
 * Service for caching HTML personalizations in Redis
 */

// Default TTL for cache entries (24 hours in seconds)
const DEFAULT_TTL = 86400;

/**
 * Key generation utilities
 */
const redisKeys = {
  /**
   * Builds the Redis key for personalization metadata
   */
  metadata: (siteId: string, segmentId: string): string => 
    `site:${siteId}:segments:${segmentId}:metadata`,

  /**
   * Builds the Redis key for a specific personalization modification
   */
  personalization: (siteId: string, segmentId: string, modificationId: string): string => 
    `site:${siteId}:segments:${segmentId}:personalizations:${modificationId}`,

  /**
   * Builds the Redis key for all personalizations of a segment
   */
  allPersonalizations: (siteId: string, segmentId: string): string => 
    `site:${siteId}:segments:${segmentId}:all_personalizations`,

  /**
   * Builds the Redis key for element type index
   */
  elementType: (siteId: string, segmentId: string, elementType: string): string => 
    `site:${siteId}:segments:${segmentId}:element_types:${elementType}`,
    
  /**
   * Builds the Redis key for the implementation code
   */
  implementationCode: (siteId: string, segmentId: string): string => 
    `site:${siteId}:segments:${segmentId}:implementation_code`
};

/**
 * Redis client utilities
 */
const redisUtils = {
  /**
   * Initialize Redis connection
   * @returns Redis client or null if connection failed
   */
  initRedis: async () => {
    try {
      const isReady = await waitForRedis();
      if (!isReady) {
        logError('PersonalizationCache', 'Redis is not ready after timeout');
        return null;
      }
      return getRedisClient();
    } catch (error) {
      logError('PersonalizationCache', 'Error initializing Redis', error);
      return null;
    }
  },
  
  /**
   * Set a key with expiration
   */
  setWithExpiry: async (redis: any, key: string, value: any, ttl: number): Promise<boolean> => {
    try {
      await redis.set(key, value);
      await redis.expire(key, ttl);
      return true;
    } catch (error) {
      logError('PersonalizationCache', `Error setting ${key}`, error);
      return false;
    }
  }
};

/**
 * Saves HTML personalization response to Redis
 * 
 * @param personalizationResponse The personalization response to save
 * @param ttl Time to live in seconds (default 24 hours)
 * @returns true if saved successfully
 */
export async function savePersonalizationToRedis(
  personalizationResponse: PersonalizationResponse, 
  ttl: number = DEFAULT_TTL
): Promise<boolean> {
  try {
    // Validar la respuesta antes de intentar guardar
    if (!personalizationResponse || !personalizationResponse.segment_id) {
      logError('PersonalizationCache', 'Invalid personalization response');
      return false;
    }
    
    // Inicializar Redis con un log más descriptivo
    logInfo('PersonalizationCache', 'Initializing Redis connection');
    const redis = await redisUtils.initRedis();
    
    if (!redis) {
      logError('PersonalizationCache', 'Failed to connect to Redis');
      return false;
    }

    const segmentId = personalizationResponse.segment_id;
    const siteId = personalizationResponse.metadata?.request?.parameters?.site_id || 'default';
    const personalizationId = personalizationResponse.personalization_id;
    
    // Verificar que tenemos un ID de personalización
    if (!personalizationId) {
      logError('PersonalizationCache', 'Missing personalization ID');
      return false;
    }
    
    logInfo('PersonalizationCache', `Saving personalization to Redis: ${personalizationId} (Site: ${siteId}, Segment: ${segmentId})`);

    try {
      // Save metadata as hash
      const metadataKey = redisKeys.metadata(siteId, segmentId);
      await redis.hset(metadataKey, {
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        url: personalizationResponse.url,
        personalization_id: personalizationId,
        implementation_method: personalizationResponse.implementation_code.type,
        status: personalizationResponse.metadata?.analysis?.status || 'success',
        model_used: personalizationResponse.metadata?.analysis?.modelUsed || 'unknown',
        provider: personalizationResponse.metadata?.analysis?.aiProvider || 'unknown',
        version: "1.0"
      });
      
      // Set TTL for metadata
      await redis.expire(metadataKey, ttl);
      logDebug('PersonalizationCache', `Saved metadata for ${personalizationId}`);
      
      // Guardar el código de implementación completo
      const implementationCode = personalizationResponse.implementation_code;
      if (implementationCode && implementationCode.code) {
        const codeKey = redisKeys.implementationCode(siteId, segmentId);
        await redis.hset(codeKey, {
          code: implementationCode.code,
          type: implementationCode.type,
          generated_at: new Date().toISOString(),
          personalization_id: personalizationId
        });
        
        // Set TTL for implementation code
        await redis.expire(codeKey, ttl);
        logInfo('PersonalizationCache', `Saved implementation code (${implementationCode.type}, ${implementationCode.code.length} chars)`);
      } else {
        logWarning('PersonalizationCache', 'No implementation code to save');
      }
      
      // Array to store all modification IDs
      const allModificationIds: string[] = [];
      
      // Map to store element types and their modification IDs
      const elementTypeMap: Record<string, string[]> = {};
      
      // Verificar que tenemos personalizaciones
      const personalizations = personalizationResponse.personalizations || [];
      if (personalizations.length === 0) {
        logInfo('PersonalizationCache', 'No personalizations to save');
        return true; // Consideramos exitoso guardar metadata y código de implementación sin personalizations
      }
      
      // Save each personalization modification
      for (const modification of personalizations) {
        const modId = modification.id;
        if (!modId) {
          logWarning('PersonalizationCache', 'Skipping personalization with missing ID');
          continue;
        }
        
        allModificationIds.push(modId);
        
        // Save the modification details as hash
        const modKey = redisKeys.personalization(siteId, segmentId, modId);
        const modData = {
          selector: modification.selector || '',
          operation_type: modification.operation_type || 'replace',
          'html:before': modification.before_html || '',
          'html:after': modification.after_html || ''
        };
        
        await redis.hset(modKey, modData);
        
        // Set TTL for the modification
        await redis.expire(modKey, ttl);
        
        // Track element types for indexing - keep this for backward compatibility
        const elementType = 'content';
        if (!elementTypeMap[elementType]) {
          elementTypeMap[elementType] = [];
        }
        elementTypeMap[elementType].push(modId);
      }
      
      // Save all modifications as a set
      if (allModificationIds.length > 0) {
        const allModsKey = redisKeys.allPersonalizations(siteId, segmentId);
        await redis.sadd(allModsKey, ...allModificationIds);
        await redis.expire(allModsKey, ttl);
      
        // Save element type indices
        for (const [elementType, modIds] of Object.entries(elementTypeMap)) {
          const typeKey = redisKeys.elementType(siteId, segmentId, elementType);
          await redis.sadd(typeKey, ...modIds);
          await redis.expire(typeKey, ttl);
        }
      }
      
      logInfo('PersonalizationCache', `Successfully saved ${allModificationIds.length} personalizations to Redis`);
      return true;
      
    } catch (error) {
      logError('PersonalizationCache', `Redis operation failed: ${(error as Error).message}`, error);
      return false;
    }
  } catch (error) {
    logError('PersonalizationCache', 'Error saving to Redis:', error);
    return false;
  }
}

// Función auxiliar para los logs de advertencia
function logWarning(service: string, message: string) {
  console.warn(`[${service}] ${message}`);
}

/**
 * Converts Redis hash to PersonalizationModification
 */
function convertRedisHashToModification(hash: Record<string, string>, modId: string): PersonalizationModification {
  return {
    id: modId,
    selector: hash.selector,
    operation_type: (hash.operation_type as 'replace' | 'append' | 'remove' | 'rewrite') || 'replace',
    after_html: hash['html:after'] || '<div>No disponible</div>',
    before_html: hash['html:before']
  };
}

/**
 * Creates a personalization response object from Redis data
 */
function createPersonalizationResponse(
  url: string,
  segmentId: string,
  siteId: string,
  metadata: Record<string, string>,
  personalizations: PersonalizationModification[],
  implementationCode?: Record<string, string>
): PersonalizationResponse {
  // Use the stored implementation code if available, otherwise generate it
  let codeImplementation;
  
  if (implementationCode && implementationCode.code) {
    codeImplementation = {
      type: (implementationCode.type || 'javascript') as 'javascript' | 'html' | 'hybrid',
      code: implementationCode.code
    };
    logInfo('PersonalizationCache', 'Using stored implementation code');
  } else {
    // Generate the implementation code statically
    const implementationType = (metadata.implementation_method || 'javascript') as 'javascript' | 'html' | 'hybrid';
    codeImplementation = generateImplementationCode(personalizations, implementationType);
    logInfo('PersonalizationCache', 'Generated new implementation code');
  }
  
  return {
    url: metadata.url,
    segment_id: segmentId,
    personalization_id: metadata.personalization_id,
    personalizations,
    implementation_code: codeImplementation,
    metadata: {
      request: {
        timestamp: metadata.created_at,
        parameters: {
          url,
          segment_id: segmentId,
          site_id: siteId
        }
      },
      analysis: {
        modelUsed: metadata.model_used || 'unknown',
        aiProvider: metadata.provider || 'unknown',
        processingTime: '0ms',
        segmentDataSource: 'cache',
        siteScanDate: metadata.created_at,
        status: 'success',
        personalizationStrategy: codeImplementation.type,
        storage: {
          cached: true,
          cacheSuccess: true,
          timestamp: new Date().toISOString()
        },
        minifiedCode: true
      }
    }
  };
}

/**
 * Retrieves HTML personalization from Redis by segment ID and site ID
 * 
 * @param segmentId The segment ID
 * @param url The URL of the page being personalized
 * @param siteId The site ID (optional, defaults to 'default')
 * @returns The personalization response or null if not found
 */
export async function getPersonalizationFromRedis(
  segmentId: string,
  url: string,
  siteId: string = 'default'
): Promise<PersonalizationResponse | null> {
  try {
    const redis = await redisUtils.initRedis();
    if (!redis) return null;
    
    // Get metadata
    const metadataKey = redisKeys.metadata(siteId, segmentId);
    const metadata = await redis.hgetall(metadataKey);
    
    // If no metadata found, return null
    if (!metadata || Object.keys(metadata).length === 0) {
      logInfo('PersonalizationCache', `No personalization found in Redis for segment ${segmentId}`);
      return null;
    }
    
    // Check if the URL matches
    if (metadata.url !== url) {
      logInfo('PersonalizationCache', `Found personalization but URL doesn't match: ${metadata.url} vs ${url}`);
      return null;
    }
    
    // Get implementation code
    const codeKey = redisKeys.implementationCode(siteId, segmentId);
    const implementationCode = await redis.hgetall(codeKey);
    
    if (implementationCode && implementationCode.code) {
      logInfo('PersonalizationCache', `Found implementation code: ${implementationCode.type}, ${implementationCode.code.length} chars`);
    } else {
      logWarning('PersonalizationCache', 'Implementation code not found in Redis, will generate new code');
    }
    
    // Get all modification IDs
    const allModsKey = redisKeys.allPersonalizations(siteId, segmentId);
    const modificationIds = await redis.smembers(allModsKey);
    
    if (!modificationIds || modificationIds.length === 0) {
      logInfo('PersonalizationCache', `No modifications found for personalization ${metadata.personalization_id}`);
      return null;
    }
    
    // Get all modifications
    const personalizations: PersonalizationModification[] = [];
    for (const modId of modificationIds) {
      const modKey = redisKeys.personalization(siteId, segmentId, modId);
      const mod = await redis.hgetall(modKey);
      
      if (mod && Object.keys(mod).length > 0) {
        personalizations.push(convertRedisHashToModification(mod, modId));
      }
    }
    
    logInfo('PersonalizationCache', `Successfully retrieved ${personalizations.length} personalizations from Redis`);
    
    // Construct and return the personalization response
    return createPersonalizationResponse(
      url, 
      segmentId, 
      siteId, 
      metadata, 
      personalizations,
      // Pasar el código de implementación solo si existe y tiene las propiedades necesarias
      implementationCode && implementationCode.code ? implementationCode : undefined
    );
  } catch (error) {
    logError('PersonalizationCache', 'Error retrieving from Redis:', error);
    return null;
  }
} 