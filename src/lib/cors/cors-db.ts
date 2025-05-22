import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Cache configuration
 */
class DomainCache {
  private cache: Map<string, { allowed: boolean; timestamp: number }>;
  private readonly maxEntries: number;
  private readonly cacheDuration: number;
  private cleanupInterval: NodeJS.Timeout | null;

  constructor(options: {
    maxEntries?: number;
    cacheDuration?: number;
    cleanupInterval?: number;
  } = {}) {
    this.cache = new Map();
    this.maxEntries = options.maxEntries || 1000; // Default max 1000 entries
    this.cacheDuration = options.cacheDuration || 5 * 60 * 1000; // Default 5 minutes
    this.cleanupInterval = null;
    
    // Start cleanup interval
    this.startCleanup(options.cleanupInterval || 60 * 1000); // Default 1 minute cleanup
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
    
    // Prevent the interval from keeping the process alive
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
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
    // If cache is full, remove oldest entry
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = Array.from(this.cache.entries())
        .reduce((oldest, current) => 
          current[1].timestamp < oldest[1].timestamp ? current : oldest
        )[0];
      this.cache.delete(oldestKey);
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

// Ensure cleanup on process exit
process.on('beforeExit', () => {
  domainCache.stop();
});

/**
 * Extracts the domain from a URL or origin string
 * Handles both URLs and origin strings (protocol://domain)
 */
function extractDomain(origin: string): string | null {
  try {
    // Remove any trailing slashes
    origin = origin.trim().replace(/\/$/, '');
    
    // Try to parse as URL
    const url = new URL(origin);
    return url.hostname;
  } catch (error) {
    console.error('[CORS-DB] Error extracting domain from origin:', error);
    return null;
  }
}

/**
 * Check if a given origin is allowed by checking the sites and allowed_domains tables
 */
export async function isOriginAllowedInDb(origin: string): Promise<boolean> {
  if (!origin) {
    return true;
  }

  // Extract domain from origin
  const domain = extractDomain(origin);
  if (!domain) {
    console.error('[CORS-DB] Could not extract domain from origin:', origin);
    return false;
  }

  // Check cache first
  const cachedResult = domainCache.get(domain);
  if (cachedResult !== null) {
    console.log('[CORS-DB] Using cached result for domain:', domain);
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
        console.log('[CORS-DB] Domain found in sites table');
        domainCache.set(domain, true);
        return true;
      }
    }

    // Then check in allowed_domains table
    const { data: domainData, error: domainError } = await supabaseAdmin
      .from('allowed_domains')
      .select('sites')
      .contains('sites', [domain]);

    if (domainError) {
      console.error('[CORS-DB] Error checking allowed_domains table:', domainError);
    } else if (domainData && domainData.length > 0) {
      console.log('[CORS-DB] Domain found in allowed_domains table');
      domainCache.set(domain, true);
      return true;
    }

    console.log('[CORS-DB] Domain not found in any table:', domain);
    domainCache.set(domain, false);
    return false;

  } catch (error) {
    console.error('[CORS-DB] Unexpected error checking domain:', error);
    // Don't cache errors
    return false;
  }
} 