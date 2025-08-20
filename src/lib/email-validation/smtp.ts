import * as tls from 'tls';
import { MXRecord, createSocketWithTimeout, readSMTPResponse, sendSMTPCommand, extractDomain } from './utils';
import { checkDomainReputation } from './reputation';

/**
 * Core SMTP validation logic (extracted for reuse)
 */
export async function performSMTPValidationCore(email: string, mxRecord: MXRecord): Promise<{
  isValid: boolean;
  result: 'valid' | 'invalid' | 'unknown' | 'disposable' | 'catchall' | 'risky';
  flags: string[];
  message: string;
}> {
  let socket: any = null;
  
  try {
    console.log(`[VALIDATE_EMAIL] Connecting to SMTP server: ${mxRecord.exchange}:25`);
    
    // Create socket connection
    const connectionResult = await createSocketWithTimeout(mxRecord.exchange, 25, 6000);
    
    if (!connectionResult.success) {
      return {
        isValid: false,
        result: 'unknown',
        flags: ['connection_failed', connectionResult.errorCode?.toLowerCase() || 'connection_error'],
        message: connectionResult.error || 'Failed to connect to SMTP server'
      };
    }
    
    socket = connectionResult.socket!;
    
    // Read initial greeting
    const greetingResult = await readSMTPResponse(socket);
    
    if (!greetingResult.success) {
      return {
        isValid: false,
        result: 'unknown',
        flags: ['greeting_failed', greetingResult.errorCode?.toLowerCase() || 'response_error'],
        message: greetingResult.error || 'Failed to read server greeting'
      };
    }
    
    const greeting = greetingResult.response!;
    console.log(`[VALIDATE_EMAIL] Server greeting: ${greeting.code} ${greeting.message}`);
    
    if (greeting.code !== 220) {
      return {
        isValid: false,
        result: 'unknown',
        flags: ['server_not_ready'],
        message: `SMTP server not ready: ${greeting.code} ${greeting.message}`
      };
    }
    
    // Send EHLO command
    const ehloResult = await sendSMTPCommand(socket, 'EHLO validateemail.local');
    
    if (!ehloResult.success) {
      return {
        isValid: false,
        result: 'unknown',
        flags: ['ehlo_failed', ehloResult.errorCode?.toLowerCase() || 'command_error'],
        message: ehloResult.error || 'EHLO command failed'
      };
    }
    
    const ehloResponse = ehloResult.response!;
    console.log(`[VALIDATE_EMAIL] EHLO response: ${ehloResponse.code} ${ehloResponse.message}`);
    
    // Check if STARTTLS is supported and required
    let tlsSocket: tls.TLSSocket | null = null;
    if (ehloResponse.message.includes('STARTTLS')) {
      try {
        console.log(`[VALIDATE_EMAIL] Starting TLS connection`);
        const startTlsResult = await sendSMTPCommand(socket, 'STARTTLS');
        
        if (startTlsResult.success && startTlsResult.response!.code === 220) {
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
          const tlsEhloResult = await readSMTPResponse(tlsSocket);
          if (tlsEhloResult.success) {
            console.log(`[VALIDATE_EMAIL] TLS EHLO response: ${tlsEhloResult.response!.code} ${tlsEhloResult.response!.message}`);
          } else {
            console.log(`[VALIDATE_EMAIL] TLS EHLO failed: ${tlsEhloResult.error}`);
          }
        }
      } catch (tlsError) {
        console.log(`[VALIDATE_EMAIL] TLS upgrade failed, continuing without TLS:`, tlsError);
      }
    }
    
    const activeSocket = tlsSocket || socket;
    
    // Send MAIL FROM command
    const mailFromResult = await sendSMTPCommand(activeSocket, 'MAIL FROM:<test@validateemail.local>');
    
    if (!mailFromResult.success) {
      return {
        isValid: false,
        result: 'unknown',
        flags: ['mail_from_failed', mailFromResult.errorCode?.toLowerCase() || 'command_error'],
        message: mailFromResult.error || 'MAIL FROM command failed'
      };
    }
    
    const mailFromResponse = mailFromResult.response!;
    console.log(`[VALIDATE_EMAIL] MAIL FROM response: ${mailFromResponse.code} ${mailFromResponse.message}`);
    
    if (mailFromResponse.code !== 250) {
      return {
        isValid: false,
        result: 'unknown',
        flags: ['mail_from_rejected'],
        message: `MAIL FROM rejected: ${mailFromResponse.code} ${mailFromResponse.message}`
      };
    }
    
    // Send RCPT TO command - this is the key validation step
    const rcptToResult = await sendSMTPCommand(activeSocket, `RCPT TO:<${email}>`);
    
    if (!rcptToResult.success) {
      return {
        isValid: false,
        result: 'unknown',
        flags: ['rcpt_to_failed', rcptToResult.errorCode?.toLowerCase() || 'command_error'],
        message: rcptToResult.error || 'RCPT TO command failed'
      };
    }
    
    const rcptToResponse = rcptToResult.response!;
    console.log(`[VALIDATE_EMAIL] RCPT TO response: ${rcptToResponse.code} ${rcptToResponse.message}`);
    
    // Send QUIT command (non-critical)
    const quitResult = await sendSMTPCommand(activeSocket, 'QUIT');
    if (!quitResult.success) {
      console.log(`[VALIDATE_EMAIL] QUIT command failed (non-critical):`, quitResult.error);
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
    // This catch block should rarely be reached now since we handle errors gracefully above
    console.error(`[VALIDATE_EMAIL] Unexpected SMTP validation error:`, error);
    
    return {
      isValid: false,
      result: 'unknown',
      flags: ['unexpected_error'],
      message: `Unexpected error during SMTP validation: ${error.message || 'Unknown error'}`
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
export async function detectCatchallDomain(domain: string, mxRecord: MXRecord): Promise<{
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
 * Performs SMTP validation for an email address with advanced detection
 */
export async function performSMTPValidation(email: string, mxRecord: MXRecord, aggressiveMode: boolean = false): Promise<{
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
