import { NextRequest, NextResponse } from 'next/server';
import { promises as dns } from 'dns';
import * as net from 'net';
import * as tls from 'tls';

interface MXRecord {
  exchange: string;
  priority: number;
}

interface EmailValidationResult {
  email: string;
  isValid: boolean; // Technical validity (SMTP accepts)
  deliverable: boolean; // Practical deliverability (considering bounce risk)
  result: 'valid' | 'invalid' | 'unknown' | 'disposable' | 'catchall' | 'risky';
  flags: string[];
  suggested_correction: string | null;
  execution_time: number;
  message: string;
  timestamp: string;
}

interface SMTPResponse {
  code: number;
  message: string;
}

/**
 * Checks if a domain exists by performing a basic DNS lookup
 */
async function checkDomainExists(domain: string): Promise<{
  exists: boolean;
  hasARecord: boolean;
  errorCode?: string;
  errorMessage?: string;
}> {
  try {
    // Try to resolve A records first (most basic domain check)
    const addresses = await dns.resolve4(domain);
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
      const ipv6Addresses = await dns.resolve6(domain);
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
 * Attempts fallback validation when MX lookup fails
 */
async function attemptFallbackValidation(domain: string): Promise<{
  canReceiveEmail: boolean;
  fallbackMethod: string;
  confidence: number;
  flags: string[];
  message: string;
}> {
  const flags: string[] = [];
  
  try {
    // Method 1: Check for common mail subdomains
    const commonMailSubdomains = ['mail', 'smtp', 'mx', 'mx1', 'mx2'];
    
    for (const subdomain of commonMailSubdomains) {
      try {
        const mailDomain = `${subdomain}.${domain}`;
        await dns.resolve4(mailDomain);
        
        // If mail subdomain exists, domain likely supports email
        return {
          canReceiveEmail: true,
          fallbackMethod: 'mail_subdomain_detection',
          confidence: 60,
          flags: ['mail_subdomain_found', 'fallback_validation'],
          message: `Mail subdomain detected: ${mailDomain}`
        };
      } catch (error) {
        // Continue to next subdomain
      }
    }
    
    // Method 2: Check for common email ports (25, 587, 465)
    const emailPorts = [25, 587, 465];
    
    for (const port of emailPorts) {
      try {
        // Try to connect to the domain on email ports
        const socket = await createSocketWithTimeout(domain, port, 3000);
        socket.destroy();
        
        return {
          canReceiveEmail: true,
          fallbackMethod: 'email_port_detection',
          confidence: 70,
          flags: [`port_${port}_open`, 'fallback_validation'],
          message: `Email port ${port} is accessible on domain`
        };
      } catch (error) {
        // Continue to next port
      }
    }
    
    // Method 3: Check for TXT records that might indicate email service
    try {
      const txtRecords = await dns.resolveTxt(domain);
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
      // TXT lookup failed, continue
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

/**
 * Performs MX record lookup for a domain with enhanced error handling
 */
async function getMXRecords(domain: string): Promise<MXRecord[]> {
  try {
    const records = await dns.resolveMx(domain);
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
    } else if (error.code === 'ETIMEOUT') {
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
 * Creates a socket connection with timeout
 */
function createSocketWithTimeout(host: string, port: number, timeout: number = 10000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    
    const timeoutId = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection timeout to ${host}:${port}`));
    }, timeout);
    
    socket.connect(port, host, () => {
      clearTimeout(timeoutId);
      resolve(socket);
    });
    
    socket.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

/**
 * Reads SMTP response from socket
 */
function readSMTPResponse(socket: net.Socket): Promise<SMTPResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('SMTP response timeout'));
    }, 5000);
    
    socket.once('data', (data) => {
      clearTimeout(timeout);
      const response = data.toString().trim();
      const code = parseInt(response.substring(0, 3));
      const message = response.substring(4);
      resolve({ code, message });
    });
    
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Sends SMTP command and waits for response
 */
async function sendSMTPCommand(socket: net.Socket, command: string): Promise<SMTPResponse> {
  socket.write(command + '\r\n');
  return await readSMTPResponse(socket);
}

/**
 * Core SMTP validation logic (extracted for reuse)
 */
async function performSMTPValidationCore(email: string, mxRecord: MXRecord): Promise<{
  isValid: boolean;
  result: 'valid' | 'invalid' | 'unknown' | 'disposable' | 'catchall' | 'risky';
  flags: string[];
  message: string;
}> {
  let socket: net.Socket | null = null;
  
  try {
    console.log(`[VALIDATE_EMAIL] Connecting to SMTP server: ${mxRecord.exchange}:25`);
    
    // Create socket connection
    socket = await createSocketWithTimeout(mxRecord.exchange, 25, 10000);
    
    // Read initial greeting
    const greeting = await readSMTPResponse(socket);
    console.log(`[VALIDATE_EMAIL] Server greeting: ${greeting.code} ${greeting.message}`);
    
    if (greeting.code !== 220) {
      throw new Error(`SMTP server not ready: ${greeting.code} ${greeting.message}`);
    }
    
    // Send EHLO command
    const ehloResponse = await sendSMTPCommand(socket, 'EHLO validateemail.local');
    console.log(`[VALIDATE_EMAIL] EHLO response: ${ehloResponse.code} ${ehloResponse.message}`);
    
    // Check if STARTTLS is supported and required
    let tlsSocket: tls.TLSSocket | null = null;
    if (ehloResponse.message.includes('STARTTLS')) {
      try {
        console.log(`[VALIDATE_EMAIL] Starting TLS connection`);
        const startTlsResponse = await sendSMTPCommand(socket, 'STARTTLS');
        
        if (startTlsResponse.code === 220) {
          // Upgrade to TLS
          tlsSocket = tls.connect({
            socket: socket,
            servername: mxRecord.exchange,
            rejectUnauthorized: false
          });
          
          // Wait for TLS handshake
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('TLS handshake timeout')), 5000);
            tlsSocket!.once('secureConnect', () => {
              clearTimeout(timeout);
              resolve(true);
            });
            tlsSocket!.once('error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });
          });
          
          // Send EHLO again after TLS
          tlsSocket.write('EHLO validateemail.local\r\n');
          const tlsEhloResponse = await readSMTPResponse(tlsSocket);
          console.log(`[VALIDATE_EMAIL] TLS EHLO response: ${tlsEhloResponse.code} ${tlsEhloResponse.message}`);
        }
      } catch (tlsError) {
        console.log(`[VALIDATE_EMAIL] TLS upgrade failed, continuing without TLS:`, tlsError);
      }
    }
    
    const activeSocket = tlsSocket || socket;
    
    // Send MAIL FROM command
    const mailFromResponse = await sendSMTPCommand(activeSocket, 'MAIL FROM:<test@validateemail.local>');
    console.log(`[VALIDATE_EMAIL] MAIL FROM response: ${mailFromResponse.code} ${mailFromResponse.message}`);
    
    if (mailFromResponse.code !== 250) {
      throw new Error(`MAIL FROM rejected: ${mailFromResponse.code} ${mailFromResponse.message}`);
    }
    
    // Send RCPT TO command - this is the key validation step
    const rcptToResponse = await sendSMTPCommand(activeSocket, `RCPT TO:<${email}>`);
    console.log(`[VALIDATE_EMAIL] RCPT TO response: ${rcptToResponse.code} ${rcptToResponse.message}`);
    
    // Send QUIT command
    try {
      await sendSMTPCommand(activeSocket, 'QUIT');
    } catch (error) {
      console.log(`[VALIDATE_EMAIL] QUIT command failed (non-critical):`, error);
    }
    
    // Analyze RCPT TO response
    const flags: string[] = [];
    let result: 'valid' | 'invalid' | 'unknown' | 'disposable' | 'catchall' | 'risky' = 'unknown';
    let isValid = false;
    let message = '';
    
    if (rcptToResponse.code === 250) {
      // Email accepted
      isValid = true;
      result = 'valid';
      message = 'Email address is valid';
    } else if (rcptToResponse.code >= 550 && rcptToResponse.code <= 559) {
      // Permanent failure - email doesn't exist
      isValid = false;
      result = 'invalid';
      message = 'Email address does not exist';
      
      if (rcptToResponse.message.toLowerCase().includes('user unknown') || 
          rcptToResponse.message.toLowerCase().includes('no such user') ||
          rcptToResponse.message.toLowerCase().includes('user not found')) {
        flags.push('user_unknown');
      }
    } else if (rcptToResponse.code >= 450 && rcptToResponse.code <= 459) {
      // Temporary failure - could be valid but server issues
      result = 'unknown';
      message = 'Temporary server error - validation inconclusive';
      flags.push('temporary_failure');
    } else if (rcptToResponse.code === 421) {
      // Service not available
      result = 'unknown';
      message = 'Mail server temporarily unavailable';
      flags.push('service_unavailable');
    } else {
      // Other responses
      result = 'unknown';
      message = `Unexpected server response: ${rcptToResponse.code} ${rcptToResponse.message}`;
      flags.push('unexpected_response');
    }
    
    // Check for catchall indicators in response message
    const responseMsg = rcptToResponse.message.toLowerCase();
    if (responseMsg.includes('catch') || 
        responseMsg.includes('accept all') ||
        responseMsg.includes('accepts all') ||
        responseMsg.includes('wildcard') ||
        (rcptToResponse.code === 250 && (
          responseMsg.includes('ok') && 
          (responseMsg.includes('any') || responseMsg.includes('all'))
        ))) {
      result = 'catchall';
      flags.push('catchall_domain');
      // Catchall domains accept emails but delivery is uncertain
      isValid = true; // Server accepts it, but mark as catchall for client decision
      message = 'Email accepted by catchall domain - delivery uncertain';
    }
    
    // Check for anti-spam responses
    if (rcptToResponse.message.toLowerCase().includes('policy') ||
        rcptToResponse.message.toLowerCase().includes('spam') ||
        rcptToResponse.message.toLowerCase().includes('blocked')) {
      flags.push('anti_spam_policy');
    }
    
    return {
      isValid,
      result,
      flags,
      message
    };
    
  } catch (error: any) {
    console.error(`[VALIDATE_EMAIL] SMTP validation error:`, error);
    
    const flags: string[] = ['connection_error'];
    let message = 'Failed to validate email via SMTP';
    
    if (error.message.includes('timeout')) {
      flags.push('timeout');
      message = 'SMTP server connection timeout';
    } else if (error.message.includes('ECONNREFUSED')) {
      flags.push('connection_refused');
      message = 'SMTP server refused connection';
    } else if (error.message.includes('ENOTFOUND')) {
      flags.push('server_not_found');
      message = 'SMTP server not found';
    }
    
    return {
      isValid: false,
      result: 'unknown',
      flags,
      message
    };
  } finally {
    // Clean up connections
    if (socket) {
      try {
        socket.destroy();
      } catch (error) {
        console.log(`[VALIDATE_EMAIL] Error closing socket:`, error);
      }
    }
  }
}

/**
 * Tests if a domain is catchall by trying multiple random emails
 */
async function detectCatchallDomain(domain: string, mxRecord: MXRecord): Promise<{
  isCatchall: boolean;
  confidence: number;
  testResults: string[];
}> {
  const testEmails = [
    `nonexistent-${Date.now()}@${domain}`,
    `invalid-user-${Math.random().toString(36).substring(7)}@${domain}`,
    `test-catchall-${Date.now()}@${domain}`
  ];
  
  const results: boolean[] = [];
  const testResults: string[] = [];
  
  for (const testEmail of testEmails) {
    try {
      console.log(`[CATCHALL_TEST] Testing: ${testEmail}`);
      const result = await performSMTPValidationCore(testEmail, mxRecord);
      results.push(result.isValid);
      testResults.push(`${testEmail}: ${result.isValid ? 'ACCEPTED' : 'REJECTED'}`);
      
      // Small delay between tests to be respectful
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      results.push(false);
      testResults.push(`${testEmail}: ERROR`);
    }
  }
  
  const acceptedCount = results.filter(r => r).length;
  const confidence = acceptedCount / results.length;
  
  // If 2 or more random emails are accepted, likely catchall
  const isCatchall = acceptedCount >= 2;
  
  console.log(`[CATCHALL_TEST] Results for ${domain}:`, {
    acceptedCount,
    totalTests: results.length,
    confidence,
    isCatchall
  });
  
  return {
    isCatchall,
    confidence,
    testResults
  };
}

/**
 * Calculates confidence score for validation decision
 */
function calculateValidationConfidence(
  smtpAccepted: boolean,
  bounceRisk: 'low' | 'medium' | 'high',
  flags: string[],
  riskFactors: string[]
): {
  confidence: number; // 0-100
  confidenceLevel: 'low' | 'medium' | 'high' | 'very_high';
  shouldOverrideToInvalid: boolean;
  reasoning: string[];
} {
  let confidence = 50; // Base confidence
  const reasoning: string[] = [];
  
  // SMTP acceptance gives strong positive signal
  if (smtpAccepted) {
    confidence += 30;
    reasoning.push('SMTP server accepts email (+30)');
  } else {
    confidence -= 40;
    reasoning.push('SMTP server rejects email (-40)');
  }
  
  // Bounce risk adjustments
  switch (bounceRisk) {
    case 'high':
      confidence -= 35;
      reasoning.push('High bounce risk domain (-35)');
      break;
    case 'medium':
      confidence -= 15;
      reasoning.push('Medium bounce risk domain (-15)');
      break;
    case 'low':
      confidence += 10;
      reasoning.push('Low bounce risk domain (+10)');
      break;
  }
  
  // Flag-based adjustments
  if (flags.includes('catchall_domain')) {
    confidence -= 25;
    reasoning.push('Catchall domain detected (-25)');
  }
  
  if (flags.includes('disposable_email')) {
    confidence -= 40;
    reasoning.push('Disposable email provider (-40)');
  }
  
  if (flags.includes('user_unknown')) {
    confidence -= 30;
    reasoning.push('User unknown response (-30)');
  }
  
  if (flags.includes('anti_spam_policy')) {
    confidence -= 20;
    reasoning.push('Anti-spam policy detected (-20)');
  }
  
  if (flags.includes('invalid_format')) {
    confidence -= 50;
    reasoning.push('Invalid email format (-50)');
  }
  
  // Risk factor adjustments
  if (riskFactors.includes('high_bounce_provider')) {
    confidence -= 20;
    reasoning.push('Known high-bounce provider (-20)');
  }
  
  if (riskFactors.includes('mx_lookup_failed')) {
    confidence -= 30;
    reasoning.push('MX lookup failed (-30)');
  }
  
  if (riskFactors.includes('domain_not_found')) {
    confidence -= 50;
    reasoning.push('Domain does not exist (-50)');
  }
  
  if (riskFactors.includes('no_mx_records')) {
    confidence -= 40;
    reasoning.push('No mail servers configured (-40)');
  }
  
  if (riskFactors.includes('dns_issues')) {
    confidence -= 25;
    reasoning.push('DNS reliability issues (-25)');
  }
  
  if (riskFactors.includes('simple_mx_setup')) {
    confidence -= 5;
    reasoning.push('Simple MX setup (-5)');
  }
  
  // Ensure confidence is within bounds
  confidence = Math.max(0, Math.min(100, confidence));
  
  // Determine confidence level
  let confidenceLevel: 'low' | 'medium' | 'high' | 'very_high';
  if (confidence >= 85) confidenceLevel = 'very_high';
  else if (confidence >= 70) confidenceLevel = 'high';
  else if (confidence >= 50) confidenceLevel = 'medium';
  else confidenceLevel = 'low';
  
  // Decide if we should override to invalid
  // Override when we have high confidence that email will bounce/fail
  const shouldOverrideToInvalid = (
    // Very high confidence it's invalid
    (confidence <= 15 && confidenceLevel === 'low') ||
    // Disposable emails - always override
    flags.includes('disposable_email') ||
    // Invalid format - always override
    flags.includes('invalid_format') ||
    // No MX records - always override
    flags.includes('no_mx_record') ||
    // Domain doesn't exist - always override
    flags.includes('domain_not_found') ||
    // High bounce risk + catchall + SMTP accepted = likely false positive
    (bounceRisk === 'high' && flags.includes('catchall_domain') && smtpAccepted) ||
    // User unknown with high confidence
    (flags.includes('user_unknown') && confidence <= 25) ||
    // DNS issues with very low confidence
    (riskFactors.includes('domain_not_found') && confidence <= 20)
  );
  
  return {
    confidence,
    confidenceLevel,
    shouldOverrideToInvalid,
    reasoning
  };
}

/**
 * Checks domain reputation and bounce prediction
 */
async function checkDomainReputation(domain: string): Promise<{
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

/**
 * Performs SMTP validation for an email address with advanced detection
 */
async function performSMTPValidation(email: string, mxRecord: MXRecord, aggressiveMode: boolean = false): Promise<{
  isValid: boolean;
  deliverable: boolean;
  result: 'valid' | 'invalid' | 'unknown' | 'disposable' | 'catchall' | 'risky';
  flags: string[];
  message: string;
  confidence: number;
  confidenceLevel: 'low' | 'medium' | 'high' | 'very_high';
  reasoning: string[];
}> {
  const domain = extractDomain(email);
  
  // Check domain reputation first
  const reputationCheck = await checkDomainReputation(domain);
  
  // First, validate the actual email
  const emailResult = await performSMTPValidationCore(email, mxRecord);
  
  // Calculate deliverable based on technical validity and bounce risk
  let deliverable = emailResult.isValid;
  let finalResult = emailResult.result;
  let finalFlags = [...emailResult.flags];
  let finalMessage = emailResult.message;
  let finalIsValid = emailResult.isValid;
  
  // If email is technically valid but high bounce risk, mark as risky
  if (emailResult.isValid && reputationCheck.bounceRisk === 'high') {
    deliverable = false;
    finalResult = 'risky';
    finalFlags.push('high_bounce_risk');
    finalMessage = `Email technically valid but high bounce risk due to ${reputationCheck.riskFactors.join(', ')}`;
  }
  
  // If email is valid, test for catchall domain
  if (emailResult.isValid && emailResult.result === 'valid') {
    console.log(`[VALIDATE_EMAIL] Testing for catchall domain: ${domain}`);
    
    try {
      const catchallTest = await detectCatchallDomain(domain, mxRecord);
      
      if (catchallTest.isCatchall) {
        deliverable = false; // Catchall domains are not reliably deliverable
        finalResult = 'catchall';
        finalFlags = [...emailResult.flags, 'catchall_domain', 'catchall_detected', `confidence_${Math.round(catchallTest.confidence * 100)}%`];
        finalMessage = `Email accepted but domain is catchall (${Math.round(catchallTest.confidence * 100)}% confidence) - delivery uncertain`;
      }
    } catch (error) {
      console.log(`[VALIDATE_EMAIL] Catchall test failed, treating as regular validation:`, error);
      // Continue with original result if catchall test fails
    }
  }
  
  // Calculate confidence and decide on aggressive validation
  const confidenceAnalysis = calculateValidationConfidence(
    emailResult.isValid,
    reputationCheck.bounceRisk,
    finalFlags,
    reputationCheck.riskFactors
  );
  
  // Apply aggressive mode if enabled
  if (aggressiveMode && confidenceAnalysis.shouldOverrideToInvalid) {
    finalIsValid = false;
    deliverable = false;
    finalResult = 'invalid';
    finalFlags.push('aggressive_override');
    finalMessage = `Marked as invalid due to high confidence of delivery failure: ${confidenceAnalysis.reasoning.join(', ')}`;
    
    console.log(`[VALIDATE_EMAIL] 🔥 Aggressive override applied:`, {
      originalValid: emailResult.isValid,
      confidence: confidenceAnalysis.confidence,
      reasoning: confidenceAnalysis.reasoning
    });
  }
  
  return {
    isValid: finalIsValid,
    deliverable,
    result: finalResult,
    flags: finalFlags,
    message: finalMessage,
    confidence: confidenceAnalysis.confidence,
    confidenceLevel: confidenceAnalysis.confidenceLevel,
    reasoning: confidenceAnalysis.reasoning
  };
}

/**
 * Validates email format using regex
 */
function isValidEmailFormat(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Extracts domain from email address
 */
function extractDomain(email: string): string {
  return email.split('@')[1];
}

/**
 * Checks if domain is a known disposable email provider
 */
function isDisposableEmail(domain: string): boolean {
  const disposableDomains = [
    '10minutemail.com', 'tempmail.org', 'guerrillamail.com', 'mailinator.com',
    'yopmail.com', 'temp-mail.org', 'throwaway.email', 'maildrop.cc',
    'sharklasers.com', 'guerrillamail.info', 'guerrillamail.biz', 'guerrillamail.de',
    'grr.la', 'guerrillamail.net', 'guerrillamail.org', 'spam4.me',
    'tempail.com', 'tempemail.com', 'tempinbox.com', 'emailondeck.com'
  ];
  
  return disposableDomains.includes(domain.toLowerCase());
}

/**
 * POST /api/agents/tools/validateEmail
 * 
 * Validates an email address using SMTP validation with catchall detection
 * 
 * Body:
 * {
 *   "email": "email@example.com",
 *   "aggressiveMode": false  // Optional: Enable aggressive validation
 * }
 * 
 * Response format with enhanced validation:
 * {
 *   "success": true,
 *   "data": {
 *     "email": "email@example.com",
 *     "isValid": true,        // Technical validity (SMTP accepts)
 *     "deliverable": false,   // Practical deliverability (considering bounce risk)
 *     "result": "risky",      // valid, invalid, disposable, catchall, risky, unknown
 *     "flags": ["high_bounce_risk"],
 *     "suggested_correction": null,
 *     "execution_time": 123,
 *     "message": "Email technically valid but high bounce risk",
 *     "timestamp": "2024-01-01T00:00:00.000Z",
 *     "bounceRisk": "high",
 *     "reputationFlags": ["strict_spam_policy"],
 *     "riskFactors": ["high_bounce_provider"],
 *     "confidence": 25,
 *     "confidenceLevel": "low",
 *     "reasoning": ["SMTP server accepts email (+30)", "High bounce risk domain (-35)"],
 *     "aggressiveMode": true
 *   }
 * }
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    console.log(`[VALIDATE_EMAIL] 🚀 Starting email validation process`);
    
    // Parse request body
    const body = await request.json();
    const { email, aggressiveMode = false } = body;
    
    // Validate that email is provided
    if (!email) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'EMAIL_REQUIRED',
          message: 'Email is required',
          details: 'Please provide an email address to validate'
        }
      }, {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    console.log(`[VALIDATE_EMAIL] 📧 Validating email: ${email} (aggressive: ${aggressiveMode})`);
    
    // Basic format validation
    if (!isValidEmailFormat(email)) {
      const executionTime = Date.now() - startTime;
      return NextResponse.json({
        success: true,
        data: {
          email,
          isValid: false,
          result: 'invalid',
          flags: ['invalid_format'],
          suggested_correction: null,
          execution_time: executionTime,
          message: 'Invalid email format',
          timestamp: new Date().toISOString(),
          bounceRisk: 'high',
          reputationFlags: ['invalid_format']
        }
      }, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const domain = extractDomain(email);
    console.log(`[VALIDATE_EMAIL] 🌐 Domain extracted: ${domain}`);
    
    // Check if domain exists before proceeding with other validations
    console.log(`[VALIDATE_EMAIL] 🔍 Checking domain existence: ${domain}`);
    const domainCheck = await checkDomainExists(domain);
    
    if (!domainCheck.exists) {
      const executionTime = Date.now() - startTime;
      console.log(`[VALIDATE_EMAIL] ❌ Domain does not exist: ${domain}`);
      
      return NextResponse.json({
        success: true,
        data: {
          email,
          isValid: false,
          deliverable: false,
          result: 'invalid',
          flags: ['domain_not_found', 'no_dns_records'],
          suggested_correction: null,
          execution_time: executionTime,
          message: domainCheck.errorMessage || 'Domain does not exist',
          timestamp: new Date().toISOString(),
          bounceRisk: 'high',
          reputationFlags: ['non_existent_domain'],
          riskFactors: ['domain_not_found'],
          confidence: 95,
          confidenceLevel: 'very_high',
          reasoning: [
            'Domain does not exist in DNS (-95)',
            `Error: ${domainCheck.errorCode || 'DOMAIN_NOT_FOUND'}`
          ],
          aggressiveMode: aggressiveMode
        }
      }, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    console.log(`[VALIDATE_EMAIL] ✅ Domain exists: ${domain} (IPv4: ${domainCheck.hasARecord})`);
    
    // Check for disposable email domains
    if (isDisposableEmail(domain)) {
      const executionTime = Date.now() - startTime;
      return NextResponse.json({
        success: true,
        data: {
          email,
          isValid: false,
          result: 'disposable',
          flags: ['disposable_email'],
          suggested_correction: null,
          execution_time: executionTime,
          message: 'Email is from a disposable email provider',
          timestamp: new Date().toISOString(),
          bounceRisk: 'high',
          reputationFlags: ['disposable_provider']
        }
      }, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Get MX records for the domain
    console.log(`[VALIDATE_EMAIL] 🔍 Looking up MX records for domain: ${domain}`);
    let mxRecords: MXRecord[];
    
    try {
      mxRecords = await getMXRecords(domain);
      console.log(`[VALIDATE_EMAIL] 📋 Found ${mxRecords.length} MX records:`, mxRecords);
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      console.error(`[VALIDATE_EMAIL] ❌ Failed to get MX records:`, error);
      
      // Determine appropriate response based on error type
      let result: 'invalid' | 'unknown' | 'risky' = 'invalid';
      let flags: string[] = [];
      let message = 'Domain validation failed';
      let bounceRisk: 'low' | 'medium' | 'high' = 'high';
      let reputationFlags: string[] = [];
      let confidence = 25;
      let confidenceLevel: 'low' | 'medium' | 'high' | 'very_high' = 'low';
      let reasoning: string[] = [];
      let isValid = false;
      let deliverable = false;
      
      // Try fallback validation for certain error types
      let fallbackResult = null;
      if (error.code === 'NO_MX_RECORDS' || error.code === 'DNS_TIMEOUT' || error.code === 'DNS_SERVER_FAILURE') {
        console.log(`[VALIDATE_EMAIL] 🔄 Attempting fallback validation for ${domain}`);
        try {
          fallbackResult = await attemptFallbackValidation(domain);
          console.log(`[VALIDATE_EMAIL] 📋 Fallback result:`, fallbackResult);
        } catch (fallbackError) {
          console.log(`[VALIDATE_EMAIL] ❌ Fallback validation failed:`, fallbackError);
        }
      }
      
      switch (error.code) {
        case 'DOMAIN_NOT_FOUND':
          result = 'invalid';
          flags = ['domain_not_found', 'no_mx_record'];
          message = 'Domain does not exist';
          bounceRisk = 'high';
          reputationFlags = ['non_existent_domain'];
          confidence = 95;
          confidenceLevel = 'very_high';
          reasoning = ['Domain does not exist (-95)', 'Error: DOMAIN_NOT_FOUND'];
          break;
          
        case 'NO_MX_RECORDS':
          if (fallbackResult?.canReceiveEmail) {
            result = 'risky';
            isValid = true;
            deliverable = false;
            flags = ['no_mx_record', ...fallbackResult.flags];
            message = `No MX records but ${fallbackResult.message}`;
            bounceRisk = 'high';
            reputationFlags = ['no_mx_but_mail_capable'];
            confidence = fallbackResult.confidence;
            confidenceLevel = confidence >= 70 ? 'high' : confidence >= 50 ? 'medium' : 'low';
            reasoning = [
              'No MX records found (-40)',
              `Fallback validation: ${fallbackResult.fallbackMethod} (+${fallbackResult.confidence})`
            ];
          } else {
            result = 'invalid';
            flags = ['no_mx_record'];
            message = 'Domain exists but has no mail servers configured';
            bounceRisk = 'high';
            reputationFlags = ['no_mail_service'];
            confidence = 90;
            confidenceLevel = 'very_high';
            reasoning = ['No MX records and no fallback methods succeeded (-90)'];
          }
          break;
          
        case 'DNS_TIMEOUT':
          if (fallbackResult?.canReceiveEmail) {
            result = 'risky';
            isValid = true;
            deliverable = false;
            flags = ['dns_timeout', ...fallbackResult.flags];
            message = `DNS timeout but ${fallbackResult.message}`;
            bounceRisk = 'medium';
            reputationFlags = ['dns_issues_but_mail_capable'];
            confidence = Math.max(fallbackResult.confidence - 20, 10);
            confidenceLevel = confidence >= 50 ? 'medium' : 'low';
            reasoning = [
              'DNS timeout issues (-30)',
              `Fallback validation: ${fallbackResult.fallbackMethod} (+${fallbackResult.confidence})`
            ];
          } else {
            result = 'unknown';
            flags = ['dns_timeout'];
            message = 'DNS lookup timeout - domain validation inconclusive';
            bounceRisk = 'medium';
            reputationFlags = ['dns_issues'];
            confidence = 25;
            reasoning = ['DNS timeout prevents validation (-75)'];
          }
          break;
          
        case 'DNS_SERVER_FAILURE':
          if (fallbackResult?.canReceiveEmail) {
            result = 'risky';
            isValid = true;
            deliverable = false;
            flags = ['dns_server_failure', ...fallbackResult.flags];
            message = `DNS server failure but ${fallbackResult.message}`;
            bounceRisk = 'medium';
            reputationFlags = ['dns_issues_but_mail_capable'];
            confidence = Math.max(fallbackResult.confidence - 20, 10);
            confidenceLevel = confidence >= 50 ? 'medium' : 'low';
            reasoning = [
              'DNS server failure (-30)',
              `Fallback validation: ${fallbackResult.fallbackMethod} (+${fallbackResult.confidence})`
            ];
          } else {
            result = 'unknown';
            flags = ['dns_server_failure'];
            message = 'DNS server failure - domain validation inconclusive';
            bounceRisk = 'medium';
            reputationFlags = ['dns_issues'];
            confidence = 25;
            reasoning = ['DNS server failure prevents validation (-75)'];
          }
          break;
          
        default:
          result = 'unknown';
          flags = ['dns_error'];
          message = 'DNS resolution failed - domain validation inconclusive';
          bounceRisk = 'high';
          reputationFlags = ['dns_error'];
          confidence = 15;
          reasoning = ['DNS resolution failed (-85)', `Error type: ${error.code || 'DNS_ERROR'}`];
      }
      
      return NextResponse.json({
        success: true,
        data: {
          email,
          isValid,
          deliverable,
          result,
          flags,
          suggested_correction: null,
          execution_time: executionTime,
          message,
          timestamp: new Date().toISOString(),
          bounceRisk,
          reputationFlags,
          riskFactors: [error.code?.toLowerCase() || 'dns_error'],
          confidence,
          confidenceLevel,
          reasoning,
          aggressiveMode: aggressiveMode,
          ...(fallbackResult && { fallbackValidation: fallbackResult })
        }
      }, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (mxRecords.length === 0) {
      const executionTime = Date.now() - startTime;
      return NextResponse.json({
        success: true,
        data: {
          email,
          isValid: false,
          result: 'invalid',
          flags: ['no_mx_record'],
          suggested_correction: null,
          execution_time: executionTime,
          message: 'Domain has no MX records',
          timestamp: new Date().toISOString(),
          bounceRisk: 'high',
          reputationFlags: ['no_mx_record']
        }
      }, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Try SMTP validation with the primary MX record
    console.log(`[VALIDATE_EMAIL] 🔌 Attempting SMTP validation with primary MX: ${mxRecords[0].exchange}`);
    
    const smtpResult = await performSMTPValidation(email, mxRecords[0], aggressiveMode);
    const executionTime = Date.now() - startTime;
    
    console.log(`[VALIDATE_EMAIL] ✅ SMTP validation completed:`, {
      isValid: smtpResult.isValid,
      deliverable: smtpResult.deliverable,
      result: smtpResult.result,
      flags: smtpResult.flags,
      executionTime
    });
    
    // Extract reputation info from the result (already included in performSMTPValidation)
    const reputationCheck = await checkDomainReputation(domain);
    
    const response = {
      success: true,
      data: {
        email,
        isValid: smtpResult.isValid,
        deliverable: smtpResult.deliverable,
        result: smtpResult.result,
        flags: [...smtpResult.flags, ...reputationCheck.reputationFlags],
        suggested_correction: null,
        execution_time: executionTime,
        message: smtpResult.message,
        timestamp: new Date().toISOString(),
        bounceRisk: reputationCheck.bounceRisk,
        reputationFlags: reputationCheck.reputationFlags,
        riskFactors: reputationCheck.riskFactors,
        confidence: smtpResult.confidence,
        confidenceLevel: smtpResult.confidenceLevel,
        reasoning: smtpResult.reasoning,
        aggressiveMode: aggressiveMode
      }
    };
    
    return NextResponse.json(response, {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error: any) {
    const executionTime = Date.now() - startTime;
    console.error(`[VALIDATE_EMAIL] ❌ Unexpected error:`, error);
    
    return NextResponse.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred while validating the email'
      }
    }, {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * GET /api/agents/tools/validateEmail
 * 
 * Information about the email validation endpoint
 */
export async function GET() {
  return NextResponse.json({
    success: true,
    data: {
      service: 'Advanced SMTP Email Validation',
      version: '2.0.0',
      description: 'Validate email addresses using SMTP protocol with catchall detection and bounce prediction',
      endpoints: {
        validate: {
          method: 'POST',
          path: '/api/agents/tools/validateEmail',
          description: 'Validate a single email address using advanced SMTP validation',
          body: {
            email: 'string (required) - Email address to validate',
            aggressiveMode: 'boolean (optional) - Enable aggressive validation that marks high-confidence bounces as invalid'
          },
          response: {
            success: 'boolean - Operation success status',
            data: {
              email: 'string - The validated email',
              isValid: 'boolean - Technical validity (SMTP accepts)',
              deliverable: 'boolean - Practical deliverability (considering bounce risk)',
              result: 'string - Validation result (valid, invalid, disposable, catchall, risky, unknown)',
              flags: 'array - Additional validation flags',
              suggested_correction: 'string|null - Suggested correction if available',
              execution_time: 'number - Time taken to validate in milliseconds',
              message: 'string - Human readable message',
              timestamp: 'string - ISO timestamp of validation',
              bounceRisk: 'string - Predicted bounce risk (low, medium, high)',
              reputationFlags: 'array - Domain reputation indicators',
              riskFactors: 'array - Factors that increase bounce risk',
              confidence: 'number - Confidence score (0-100)',
              confidenceLevel: 'string - Confidence level (low, medium, high, very_high)',
              reasoning: 'array - Detailed reasoning for confidence score',
              aggressiveMode: 'boolean - Whether aggressive mode was enabled'
            }
          }
        }
      },
      features: [
        'MX record lookup',
        'SMTP connection testing',
        'TLS/STARTTLS support',
        'Disposable email detection',
        'Advanced catchall domain detection',
        'Bounce risk prediction',
        'Domain reputation analysis',
        'Anti-spam policy detection',
        'Confidence scoring system',
        'Aggressive validation mode'
      ],
      timestamp: new Date().toISOString()
    }
  }, {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}