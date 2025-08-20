import { getMXRecords } from './dns';

/**
 * Checks domain reputation and bounce prediction
 */
export async function checkDomainReputation(domain: string): Promise<{
  bounceRisk: 'low' | 'medium' | 'high';
  reputationFlags: string[];
  riskFactors: string[];
}> {
  const reputationFlags: string[] = [];
  const riskFactors: string[] = [];
  let bounceRisk: 'low' | 'medium' | 'high' = 'low';
  
  // Check for common high-bounce domains
  const highBounceDomains = [
    'hotmail.com', 'outlook.com', 'live.com', // Microsoft domains with strict policies
    'aol.com', 'yahoo.com' // Known for aggressive spam filtering
  ];
  
  const mediumBounceDomains = [
    'gmail.com', 'googlemail.com' // Google has good delivery but strict policies
  ];
  
  if (highBounceDomains.includes(domain.toLowerCase())) {
    bounceRisk = 'high';
    riskFactors.push('high_bounce_provider');
    reputationFlags.push('strict_spam_policy');
  } else if (mediumBounceDomains.includes(domain.toLowerCase())) {
    bounceRisk = 'medium';
    riskFactors.push('medium_bounce_provider');
    reputationFlags.push('moderate_spam_policy');
  }
  
  // Check for corporate domains (usually lower bounce risk)
  if (domain.includes('.edu') || domain.includes('.gov') || domain.includes('.org')) {
    bounceRisk = 'low';
    reputationFlags.push('institutional_domain');
  }
  
  // Check for new domains (higher bounce risk)
  try {
    const mxRecords = await getMXRecords(domain);
    if (mxRecords.length === 1 && mxRecords[0].exchange.includes('mail.')) {
      riskFactors.push('simple_mx_setup');
    }
  } catch (error: any) {
    // Handle different types of DNS errors appropriately
    switch (error.code) {
      case 'DOMAIN_NOT_FOUND':
        riskFactors.push('domain_not_found');
        reputationFlags.push('non_existent_domain');
        bounceRisk = 'high';
        break;
      case 'NO_MX_RECORDS':
        riskFactors.push('no_mx_records');
        reputationFlags.push('no_mail_service');
        bounceRisk = 'high';
        break;
      case 'DNS_TIMEOUT':
      case 'DNS_SERVER_FAILURE':
        riskFactors.push('dns_issues');
        reputationFlags.push('dns_unreliable');
        bounceRisk = 'medium';
        break;
      default:
        riskFactors.push('mx_lookup_failed');
        bounceRisk = 'high';
    }
  }
  
  return {
    bounceRisk,
    reputationFlags,
    riskFactors
  };
}
