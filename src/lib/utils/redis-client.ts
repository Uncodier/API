import Redis from 'ioredis';

// Read Redis connection string from environment variables
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Create a Redis client
let redisClient: Redis | null = null;
let isConnecting = false;

/**
 * Get a singleton Redis client instance
 */
export function getRedisClient(): Redis {
  if (!redisClient && !isConnecting) {
    isConnecting = true;
    try {
      console.log(`[Redis Client] Attempting to connect to Redis at ${redisUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
      
      redisClient = new Redis(redisUrl, {
        retryStrategy: (times) => {
          // Retry with exponential backoff (max 10 seconds)
          const delay = Math.min(times * 100, 10000);
          console.log(`[Redis Client] Retrying connection (attempt ${times}) in ${delay}ms`);
          return delay;
        },
        maxRetriesPerRequest: 5,
        enableReadyCheck: true,
        connectTimeout: 15000, // 15 seconds
        lazyConnect: false, // Connect immediately
      });

      redisClient.on('error', (err) => {
        console.error('[Redis Client] Error connecting to Redis:', err);
        isConnecting = false;
      });

      redisClient.on('connect', () => {
        console.log('[Redis Client] Connected to Redis successfully');
        isConnecting = false;
      });
      
      redisClient.on('reconnecting', () => {
        console.log('[Redis Client] Reconnecting to Redis...');
        isConnecting = true;
      });

      redisClient.on('close', () => {
        console.log('[Redis Client] Connection closed');
        isConnecting = false;
      });

      redisClient.on('end', () => {
        console.log('[Redis Client] Connection ended');
        isConnecting = false;
      });
      
      redisClient.on('ready', () => {
        console.log('[Redis Client] Redis connection is ready');
        isConnecting = false;
      });
    } catch (error) {
      console.error('[Redis Client] Failed to create Redis client:', error);
      isConnecting = false;
      throw error;
    }
  }

  if (!redisClient) {
    throw new Error('Failed to create Redis client');
  }

  return redisClient;
}

/**
 * Removes the before_html field from analysis data to reduce storage size
 * @param analysis Analysis object that might contain before_html fields
 * @returns Analysis object with before_html fields removed
 */
export function removeBeforeHtmlFromAnalysis<T extends Record<string, any>>(analysis: T): T {
  // Create a shallow copy of the original object
  const result = { ...analysis };
  
  // Process nested objects recursively
  const processObject = (obj: Record<string, any>): void => {
    for (const key in obj) {
      // Delete before_html fields
      if (key === 'before_html') {
        delete obj[key];
      } 
      // Process arrays
      else if (Array.isArray(obj[key])) {
        obj[key].forEach((item: any) => {
          if (item && typeof item === 'object') {
            processObject(item);
          }
        });
      } 
      // Process nested objects
      else if (obj[key] && typeof obj[key] === 'object') {
        processObject(obj[key]);
      }
    }
  };
  
  // Process the copied object
  processObject(result);
  
  return result;
}

/**
 * Close the Redis connection (useful for testing and cleanup)
 */
export async function closeRedisConnection(): Promise<void> {
  if (redisClient) {
    try {
      console.log('[Redis Client] Closing Redis connection...');
      await redisClient.quit();
      redisClient = null;
      isConnecting = false;
      console.log('[Redis Client] Redis connection closed successfully');
    } catch (error) {
      console.error('[Redis Client] Error closing Redis connection:', error);
      throw error;
    }
  }
}

/**
 * Check if Redis is connected
 */
export function isRedisConnected(): boolean {
  return redisClient !== null && redisClient.status === 'ready';
}

/**
 * Wait for Redis to be ready
 * @param timeout Timeout in milliseconds (default: 15000ms = 15 seconds)
 */
export async function waitForRedis(timeout: number = 15000): Promise<boolean> {
  if (!redisClient) {
    try {
      // Intenta obtener el cliente Redis si no existe
      getRedisClient();
    } catch (error) {
      console.error('[Redis Client] Error getting Redis client:', error);
      return false;
    }
  }

  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const checkConnection = () => {
      if (redisClient?.status === 'ready') {
        console.log('[Redis Client] Redis is ready and connected');
        resolve(true);
        return;
      }
      
      if (Date.now() - startTime > timeout) {
        console.warn(`[Redis Client] Redis not ready after ${timeout}ms timeout. Current status: ${redisClient?.status}`);
        resolve(false);
        return;
      }
      
      // Check more frequently
      setTimeout(checkConnection, 50);
    };
    
    checkConnection();
  });
} 