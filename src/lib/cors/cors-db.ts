import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Cache configuration
 */
class DomainCache {
  private cache: Map<string, { allowed: boolean; timestamp: number }>;
  private readonly maxEntries: number;
  private readonly cacheDuration: number;
  private cleanupInterval: any;

  constructor(options: {
    maxEntries?: number;
    cacheDuration?: number;
    cleanupInterval?: number;
  } = {}) {
    this.cache = new Map();
    this.maxEntries = options.maxEntries || 1000; // Default max 1000 entries
    this.cacheDuration = options.cacheDuration || 5 * 60 * 1000; // Default 5 minutes
    this.cleanupInterval = null;
    
    // Start cleanup interval if we're in a Node.js environment
    if (typeof setInterval === 'function') {
      this.startCleanup(options.cleanupInterval || 60 * 1000); // Default 1 minute cleanup
    }
  }

  /**
   * Start the cleanup interval
   */
  private startCleanup(interval: number): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, interval);
  }

  /**
   * Clean expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    Array.from(this.cache.entries()).forEach(([domain, entry]) => {
      if (now - entry.timestamp > this.cacheDuration) {
        this.cache.delete(domain);
      }
    });
  }

  /**
   * Get a value from cache
   */
  get(domain: string): boolean | null {
    const entry = this.cache.get(domain);
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > this.cacheDuration) {
      this.cache.delete(domain);
      return null;
    }

    return entry.allowed;
  }

  /**
   * Set a value in cache
   */
  set(domain: string, allowed: boolean): void {
    // Clean up if cache is getting full
    if (this.cache.size >= this.maxEntries) {
      const now = Date.now();
      
      // First try to remove expired entries
      Array.from(this.cache.entries()).forEach(([key, entry]) => {
        if (now - entry.timestamp > this.cacheDuration) {
          this.cache.delete(key);
        }
      });
      
      // If still full, remove oldest entry
      if (this.cache.size >= this.maxEntries) {
        const oldestKey = Array.from(this.cache.entries())
          .reduce((oldest, current) => 
            current[1].timestamp < oldest[1].timestamp ? current : oldest
          )[0];
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(domain, {
      allowed,
      timestamp: Date.now()
    });
  }

  /**
   * Stop the cleanup interval
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Create cache instance with default settings
const domainCache = new DomainCache();

/**
 * Extracts the domain from a URL or origin string
 * Handles both URLs and origin strings (protocol://domain)
 */
function extractDomain(origin: string): string | null {
  try {
    // Validate input
    if (!origin || origin === 'null' || origin === 'undefined' || typeof origin !== 'string') {
      console.warn('[CORS-DB] Invalid origin provided:', origin);
      return null;
    }

    // Remove any trailing slashes and trim
    const cleanOrigin = origin.trim().replace(/\/$/, '');
    
    // Check if it's a valid URL format (must start with protocol)
    if (!cleanOrigin.match(/^https?:\/\//)) {
      console.warn('[CORS-DB] Origin does not start with http(s)://:', cleanOrigin);
      return null;
    }
    
    // Try to parse as URL
    const url = new URL(cleanOrigin);
    return url.hostname;
  } catch (error) {
    console.error('[CORS-DB] Error extracting domain from origin:', error);
    console.error('[CORS-DB] Origin value was:', typeof origin, origin);
    return null;
  }
}

/**
 * Check if a given origin is allowed by checking the sites and allowed_domains tables
 */
export async function isOriginAllowedInDb(origin: string): Promise<boolean> {
  // Handle null, undefined, 'null' string, or empty origins
  if (!origin || origin === 'null' || origin === 'undefined' || typeof origin !== 'string') {
    console.warn('[CORS-DB] Invalid or missing origin, allowing request:', origin);
    return true; // Allow requests without valid origin (like Postman, curl, etc.)
  }

  // Extract domain from origin
  const domain = extractDomain(origin);
  if (!domain) {
    console.error('[CORS-DB] Could not extract domain from origin:', origin);
    // If we can't extract domain but it's a localhost origin, allow it
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      console.info('[CORS-DB] Allowing localhost origin:', origin);
      return true;
    }
    return false;
  }

  // Check cache first
  const cachedResult = domainCache.get(domain);
  if (cachedResult !== null) {
    return cachedResult;
  }

  try {
    // First check in sites table using domain
    const { data: siteData, error: siteError } = await supabaseAdmin
      .from('sites')
      .select('url')
      .ilike('url', `%${domain}%`)
      .maybeSingle();

    if (siteError) {
      console.error('[CORS-DB] Error checking sites table:', siteError);
    } else if (siteData) {
      // Verify the domain matches exactly
      const siteUrl = siteData.url;
      const siteDomain = extractDomain(siteUrl);
      if (siteDomain === domain) {
        domainCache.set(domain, true);
        return true;
      }
    }

    // Then check in allowed_domains table
    const { data: domainData, error: domainError } = await supabaseAdmin
      .from('allowed_domains')
      .select('domain')
      .ilike('domain', `%${domain}%`);

    if (domainError) {
      console.error('[CORS-DB] Error checking allowed_domains table:', domainError);
    } else if (domainData && domainData.length > 0) {
      domainCache.set(domain, true);
      return true;
    }

    domainCache.set(domain, false);
    return false;

  } catch (error) {
    console.error('[CORS-DB] Unexpected error checking domain:', error);
    // Don't cache errors
    return false;
  }
} 