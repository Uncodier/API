import { promises as dns } from 'dns';
import { MXRecord, withDNSTimeout, createSocketWithTimeout } from './utils';

/**
 * Checks if a domain exists by performing a basic DNS lookup
 */
export async function checkDomainExists(domain: string): Promise<{
  exists: boolean;
  hasARecord: boolean;
  errorCode?: string;
  errorMessage?: string;
}> {
  try {
    // Try to resolve A records first (most basic domain check)
    const addresses = await withDNSTimeout(dns.resolve4(domain), 5000);
    return {
      exists: true,
      hasARecord: addresses.length > 0
    };
  } catch (error: any) {
    console.log(`[VALIDATE_EMAIL] Domain existence check failed for ${domain}:`, error.code);
    
    if (error.code === 'ENOTFOUND') {
      return {
        exists: false,
        hasARecord: false,
        errorCode: 'DOMAIN_NOT_FOUND',
        errorMessage: `Domain does not exist: ${domain}`
      };
    }
    
    // Try AAAA records (IPv6) as fallback
    try {
      const ipv6Addresses = await withDNSTimeout(dns.resolve6(domain), 5000);
      return {
        exists: true,
        hasARecord: false // No IPv4 but has IPv6
      };
    } catch (ipv6Error: any) {
      return {
        exists: false,
        hasARecord: false,
        errorCode: error.code || 'DNS_ERROR',
        errorMessage: `Domain validation failed: ${error.message}`
      };
    }
  }
}

/**
 * Performs MX record lookup for a domain with enhanced error handling and timeout
 */
export async function getMXRecords(domain: string): Promise<MXRecord[]> {
  try {
    const records = await withDNSTimeout(dns.resolveMx(domain), 5000);
    return records.sort((a, b) => a.priority - b.priority);
  } catch (error: any) {
    console.error(`[VALIDATE_EMAIL] Error resolving MX records for ${domain}:`, error);
    
    // Classify different DNS errors for better error handling
    let errorType = 'DNS_ERROR';
    let errorMessage = `Failed to resolve MX records for domain: ${domain}`;
    
    if (error.code === 'ENOTFOUND') {
      errorType = 'DOMAIN_NOT_FOUND';
      errorMessage = `Domain does not exist: ${domain}`;
    } else if (error.code === 'ENODATA') {
      errorType = 'NO_MX_RECORDS';
      errorMessage = `Domain exists but has no MX records: ${domain}`;
    } else if (error.code === 'ETIMEOUT' || error.message?.includes('timeout')) {
      errorType = 'DNS_TIMEOUT';
      errorMessage = `DNS lookup timeout for domain: ${domain}`;
    } else if (error.code === 'ESERVFAIL') {
      errorType = 'DNS_SERVER_FAILURE';
      errorMessage = `DNS server failure for domain: ${domain}`;
    }
    
    const enhancedError = new Error(errorMessage);
    (enhancedError as any).code = errorType;
    (enhancedError as any).originalError = error;
    throw enhancedError;
  }
}

/**
 * Attempts fallback validation when MX lookup fails
 */
export async function attemptFallbackValidation(domain: string): Promise<{
  canReceiveEmail: boolean;
  fallbackMethod: string;
  confidence: number;
  flags: string[];
  message: string;
}> {
  const flags: string[] = [];
  
  try {
    // Method 1: Check for TXT records that might indicate email service (fastest check first)
    try {
      const txtRecords = await withDNSTimeout(dns.resolveTxt(domain), 2000);
      const emailRelatedTxt = txtRecords.some(record => 
        record.some(txt => 
          txt.toLowerCase().includes('v=spf') || 
          txt.toLowerCase().includes('v=dmarc') ||
          txt.toLowerCase().includes('v=dkim') ||
          txt.toLowerCase().includes('mail') ||
          txt.toLowerCase().includes('smtp')
        )
      );
      
      if (emailRelatedTxt) {
        return {
          canReceiveEmail: true,
          fallbackMethod: 'email_txt_records',
          confidence: 50,
          flags: ['email_txt_records', 'fallback_validation'],
          message: 'Email-related TXT records found (SPF/DMARC/DKIM)'
        };
      }
    } catch (error) {
      // TXT lookup failed, continue to next method
    }
    
    // Method 2: Check for common mail subdomains (parallel DNS lookups)
    const commonMailSubdomains = ['mail', 'smtp', 'mx'];
    const subdomainPromises = commonMailSubdomains.map(async (subdomain) => {
      try {
        const mailDomain = `${subdomain}.${domain}`;
        await withDNSTimeout(dns.resolve4(mailDomain), 1500);
        return { success: true, subdomain: mailDomain };
      } catch (error) {
        return { success: false, subdomain: `${subdomain}.${domain}` };
      }
    });
    
    const subdomainResults = await Promise.allSettled(subdomainPromises);
    const successfulSubdomain = subdomainResults.find(result => 
      result.status === 'fulfilled' && result.value.success
    );
    
    if (successfulSubdomain && successfulSubdomain.status === 'fulfilled') {
      return {
        canReceiveEmail: true,
        fallbackMethod: 'mail_subdomain_detection',
        confidence: 60,
        flags: ['mail_subdomain_found', 'fallback_validation'],
        message: `Mail subdomain detected: ${successfulSubdomain.value.subdomain}`
      };
    }
    
    // Method 3: Quick port check (only port 25, with shorter timeout)
    try {
      const connectionResult = await createSocketWithTimeout(domain, 25, 1500);
      if (connectionResult.success && connectionResult.socket) {
        connectionResult.socket.destroy();
        return {
          canReceiveEmail: true,
          fallbackMethod: 'email_port_detection',
          confidence: 70,
          flags: ['port_25_open', 'fallback_validation'],
          message: 'Email port 25 is accessible on domain'
        };
      }
    } catch (error) {
      // Port check failed, continue
    }
    
    // No fallback methods succeeded
    return {
      canReceiveEmail: false,
      fallbackMethod: 'none',
      confidence: 10,
      flags: ['no_fallback_success'],
      message: 'No fallback validation methods succeeded'
    };
    
  } catch (error) {
    return {
      canReceiveEmail: false,
      fallbackMethod: 'error',
      confidence: 5,
      flags: ['fallback_error'],
      message: 'Fallback validation failed with error'
    };
  }
}
