import { getRedisClient, removeBeforeHtmlFromAnalysis, waitForRedis } from '@/lib/utils/redis-client';
import { StructuredAnalysisResponse } from '../types/analyzer-types';

/**
 * Service for caching site analysis results in Redis
 */

// Default TTL for cache entries (24 hours in seconds)
const DEFAULT_TTL = 86400;

/**
 * Builds the Redis key for site analysis
 */
function getSiteAnalysisKey(url: string): string {
  // Use a hash of the URL for the cache key to avoid issues with special characters
  const urlHash = Buffer.from(url).toString('base64').replace(/[+/=]/g, '');
  return `site_analysis:${urlHash}`;
}

/**
 * Saves site analysis results to Redis cache
 * 
 * @param url The URL being analyzed (used for the cache key)
 * @param analysis The analysis response object
 * @param ttl Time to live in seconds (default: 24 hours)
 * @returns true if saved successfully
 */
export async function saveSiteAnalysisToCache(
  url: string,
  analysis: StructuredAnalysisResponse,
  ttl: number = DEFAULT_TTL
): Promise<boolean> {
  try {
    // Wait for Redis to be ready
    const isReady = await waitForRedis();
    if (!isReady) {
      console.error('[AnalysisCache] Redis is not ready after timeout');
      return false;
    }
    
    const redis = getRedisClient();
    const cacheKey = getSiteAnalysisKey(url);
    
    console.log(`[AnalysisCache] Preparing to save site analysis to Redis for ${url}`);
    
    // Remove before_html fields to reduce the size of the stored data
    const optimizedAnalysis = removeBeforeHtmlFromAnalysis(analysis);
    console.log(`[AnalysisCache] Removed before_html fields from analysis data`);
    
    // Serialize and save the analysis to Redis
    const analysisJson = JSON.stringify(optimizedAnalysis);
    await redis.set(cacheKey, analysisJson, 'EX', ttl);
    
    console.log(`[AnalysisCache] Successfully saved site analysis to Redis for ${url} (${analysisJson.length} bytes)`);
    console.log(`[AnalysisCache] Cache TTL set to ${ttl} seconds`);
    
    return true;
  } catch (error) {
    console.error('[AnalysisCache] Error saving to Redis:', error);
    return false;
  }
}

/**
 * Retrieves site analysis from Redis
 * 
 * @param url The URL being analyzed (used for the cache key)
 * @returns The site analysis response or null if not found
 */
export async function getSiteAnalysisFromCache(
  url: string
): Promise<StructuredAnalysisResponse | null> {
  try {
    // Wait for Redis to be ready
    const isReady = await waitForRedis();
    if (!isReady) {
      console.error('[AnalysisCache] Redis is not ready after timeout');
      return null;
    }
    
    const redis = getRedisClient();
    const cacheKey = getSiteAnalysisKey(url);
    
    // Get the analysis from Redis
    const cachedAnalysis = await redis.get(cacheKey);
    
    // If no analysis found, return null
    if (!cachedAnalysis) {
      console.log(`[AnalysisCache] No site analysis found in Redis for ${url}`);
      return null;
    }
    
    // Parse and return the analysis
    const analysis = JSON.parse(cachedAnalysis) as StructuredAnalysisResponse;
    console.log(`[AnalysisCache] Successfully retrieved site analysis from Redis for ${url} (${cachedAnalysis.length} bytes)`);
    
    return analysis;
  } catch (error) {
    console.error('[AnalysisCache] Error retrieving from Redis:', error);
    return null;
  }
}

/**
 * Deletes site analysis from Redis cache
 * 
 * @param url The URL being analyzed (used for the cache key)
 * @returns true if deleted successfully or if key didn't exist
 */
export async function deleteSiteAnalysisFromCache(
  url: string
): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const cacheKey = getSiteAnalysisKey(url);
    
    // Delete the key from Redis
    await redis.del(cacheKey);
    
    console.log(`[AnalysisCache] Successfully deleted site analysis from Redis for ${url}`);
    return true;
  } catch (error) {
    console.error('[AnalysisCache] Error deleting from Redis:', error);
    return false;
  }
} 