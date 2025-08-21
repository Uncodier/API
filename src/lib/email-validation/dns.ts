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
  console.log(`[FALLBACK_VALIDATION] Starting fallback validation for domain: ${domain}`);
  
  // Check if we're in Vercel for faster timeouts
  const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV;
  const dnsTimeout = isVercel ? 2000 : 3000; // Faster timeouts in Vercel
  
  try {
    // Method 1: Check for TXT records that might indicate email service (fastest check first)
    console.log(`[FALLBACK_VALIDATION] Method 1: Checking TXT records for email indicators`);
    try {
      const txtRecords = await withDNSTimeout(dns.resolveTxt(domain), dnsTimeout);
      console.log(`[FALLBACK_VALIDATION] Found ${txtRecords.length} TXT records`);
      
      const emailRelatedTxt = txtRecords.some(record => 
        record.some(txt => {
          const lowerTxt = txt.toLowerCase();
          return lowerTxt.includes('v=spf') || 
                 lowerTxt.includes('v=dmarc') ||
                 lowerTxt.includes('v=dkim') ||
                 lowerTxt.includes('mail') ||
                 lowerTxt.includes('smtp') ||
                 lowerTxt.includes('email') ||
                 lowerTxt.includes('mx');
        })
      );
      
      if (emailRelatedTxt) {
        console.log(`[FALLBACK_VALIDATION] ✅ Email-related TXT records found`);
        return {
          canReceiveEmail: true,
          fallbackMethod: 'email_txt_records',
          confidence: 60,
          flags: ['email_txt_records', 'fallback_validation'],
          message: 'Email-related TXT records found (SPF/DMARC/DKIM)'
        };
      }
      console.log(`[FALLBACK_VALIDATION] No email-related TXT records found`);
    } catch (error: any) {
      console.log(`[FALLBACK_VALIDATION] TXT lookup failed:`, error.code || error.message);
    }
    
    // Method 2: Check if domain has A record and try direct SMTP connection
    console.log(`[FALLBACK_VALIDATION] Method 2: Checking A record and direct SMTP connection`);
    try {
      const aRecords = await withDNSTimeout(dns.resolve4(domain), dnsTimeout);
      if (aRecords.length > 0) {
        console.log(`[FALLBACK_VALIDATION] Domain has A record: ${aRecords[0]}`);
        
        // Try direct SMTP connection to the domain (many domains accept mail directly)
        // Skip direct SMTP in Vercel due to potential port restrictions
        if (!isVercel) {
          const connectionResult = await createSocketWithTimeout(domain, 25, 2000);
          if (connectionResult.success && connectionResult.socket) {
            console.log(`[FALLBACK_VALIDATION] ✅ Direct SMTP connection successful`);
            connectionResult.socket.destroy();
            return {
              canReceiveEmail: true,
              fallbackMethod: 'direct_smtp_connection',
              confidence: 75,
              flags: ['direct_smtp_accessible', 'fallback_validation'],
              message: 'Domain accepts direct SMTP connections (no MX record needed)'
            };
          } else {
            console.log(`[FALLBACK_VALIDATION] Direct SMTP connection failed:`, connectionResult.error);
          }
        } else {
          console.log(`[FALLBACK_VALIDATION] Skipping direct SMTP connection in Vercel environment`);
        }
      }
    } catch (error: any) {
      console.log(`[FALLBACK_VALIDATION] A record lookup failed:`, error.code || error.message);
    }
    
    // Method 3: Check for common mail subdomains (parallel DNS lookups)
    console.log(`[FALLBACK_VALIDATION] Method 3: Checking common mail subdomains`);
    const commonMailSubdomains = ['mail', 'smtp', 'mx', 'mx1', 'mx2'];
    const subdomainPromises = commonMailSubdomains.map(async (subdomain) => {
      try {
        const mailDomain = `${subdomain}.${domain}`;
        const subdomainTimeout = isVercel ? 1000 : 1500; // Faster in Vercel
        await withDNSTimeout(dns.resolve4(mailDomain), subdomainTimeout);
        console.log(`[FALLBACK_VALIDATION] Found mail subdomain: ${mailDomain}`);
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
      console.log(`[FALLBACK_VALIDATION] ✅ Mail subdomain found: ${successfulSubdomain.value.subdomain}`);
      return {
        canReceiveEmail: true,
        fallbackMethod: 'mail_subdomain_detection',
        confidence: 65,
        flags: ['mail_subdomain_found', 'fallback_validation'],
        message: `Mail subdomain detected: ${successfulSubdomain.value.subdomain}`
      };
    }
    console.log(`[FALLBACK_VALIDATION] No mail subdomains found`);
    
    // Method 4: Check for CNAME records that might point to mail services
    console.log(`[FALLBACK_VALIDATION] Method 4: Checking CNAME records for mail services`);
    try {
      const cnameRecords = await withDNSTimeout(dns.resolveCname(domain), 2000);
      const mailRelatedCname = cnameRecords.some(cname => {
        const lowerCname = cname.toLowerCase();
        return lowerCname.includes('mail') || 
               lowerCname.includes('smtp') || 
               lowerCname.includes('mx') ||
               lowerCname.includes('email') ||
               lowerCname.includes('googlemail') ||
               lowerCname.includes('outlook') ||
               lowerCname.includes('office365');
      });
      
      if (mailRelatedCname) {
        console.log(`[FALLBACK_VALIDATION] ✅ Mail-related CNAME found`);
        return {
          canReceiveEmail: true,
          fallbackMethod: 'mail_cname_detection',
          confidence: 55,
          flags: ['mail_cname_found', 'fallback_validation'],
          message: 'CNAME points to mail service provider'
        };
      }
      console.log(`[FALLBACK_VALIDATION] No mail-related CNAME records found`);
    } catch (error: any) {
      console.log(`[FALLBACK_VALIDATION] CNAME lookup failed:`, error.code || error.message);
    }
    
    // Method 5: Check for NS records pointing to known mail providers
    console.log(`[FALLBACK_VALIDATION] Method 5: Checking NS records for mail providers`);
    try {
      const nsRecords = await withDNSTimeout(dns.resolveNs(domain), 2000);
      const mailProviderNs = nsRecords.some(ns => {
        const lowerNs = ns.toLowerCase();
        return lowerNs.includes('google') || 
               lowerNs.includes('microsoft') || 
               lowerNs.includes('outlook') ||
               lowerNs.includes('office365') ||
               lowerNs.includes('zoho') ||
               lowerNs.includes('mailgun') ||
               lowerNs.includes('sendgrid');
      });
      
      if (mailProviderNs) {
        console.log(`[FALLBACK_VALIDATION] ✅ Mail provider NS records found`);
        return {
          canReceiveEmail: true,
          fallbackMethod: 'mail_provider_ns',
          confidence: 50,
          flags: ['mail_provider_ns', 'fallback_validation'],
          message: 'DNS managed by known mail service provider'
        };
      }
      console.log(`[FALLBACK_VALIDATION] No mail provider NS records found`);
    } catch (error: any) {
      console.log(`[FALLBACK_VALIDATION] NS lookup failed:`, error.code || error.message);
    }
    
    // No fallback methods succeeded
    console.log(`[FALLBACK_VALIDATION] ❌ All fallback methods failed`);
    return {
      canReceiveEmail: false,
      fallbackMethod: 'none',
      confidence: 10,
      flags: ['no_fallback_success'],
      message: 'No fallback validation methods succeeded'
    };
    
  } catch (error: any) {
    console.error(`[FALLBACK_VALIDATION] ❌ Fallback validation error:`, error);
    return {
      canReceiveEmail: false,
      fallbackMethod: 'error',
      confidence: 5,
      flags: ['fallback_error'],
      message: 'Fallback validation failed with error'
    };
  }
}
