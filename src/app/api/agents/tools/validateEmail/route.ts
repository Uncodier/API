import { NextRequest, NextResponse } from 'next/server';
import {
  isValidEmailFormat,
  extractDomain,
  isDisposableEmail,
  isLikelyNonEmailDomain,
  checkDomainExists,
  getMXRecords,
  attemptFallbackValidation,
  performSMTPValidation,
  checkDomainReputation,
  performBasicEmailValidation,
  type EmailValidationResult,
  type MXRecord
} from '@/lib/email-validation';
import { WorkflowService } from '@/lib/services/workflow-service';
import { validateWithNeverBounce } from '@/lib/email-validation/providers/neverbounce';

// Types are now imported from the email-validation module

// Function moved to @/lib/email-validation/dns

// Function moved to @/lib/email-validation/utils

// Function moved to @/lib/email-validation/dns

// Functions moved to @/lib/email-validation/utils and @/lib/email-validation/dns

// Socket and SMTP functions moved to @/lib/email-validation/utils

// SMTP validation functions moved to @/lib/email-validation/smtp

// Catchall detection moved to @/lib/email-validation/smtp

// Confidence calculation moved to @/lib/email-validation/smtp

// Domain reputation function moved to @/lib/email-validation/reputation

// Main SMTP validation function moved to @/lib/email-validation/smtp

// Utility functions moved to @/lib/email-validation/utils

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
  const TIMEOUT_MS = 60_000;
  const deadline = startTime + TIMEOUT_MS;
  
  try {
    console.log(`[VALIDATE_EMAIL] 🚀 Starting email validation process`);
    
    // Parse request body
    const body = await request.json();
    const { email, aggressiveMode = false } = body;
    let temporalInfo: { started: boolean; workflowId?: string; executionId?: string; runId?: string; status?: string; error?: string } | null = null;

    // Primary NeverBounce validation (preferred)
    const tryNeverBouncePrimary = async (): Promise<NextResponse | null> => {
      try {
        console.info(`[VALIDATE_EMAIL] 🔁 Trying NeverBounce (primary) via SDK`);
        const nb = await validateWithNeverBounce(email);
        const originalResult = nb.result as 'valid' | 'invalid' | 'disposable' | 'catchall' | 'unknown';
        let mappedResult: 'valid' | 'invalid' | 'disposable' | 'catchall' | 'unknown' = originalResult;
        let isValidMapped = nb.isValid;
        let deliverable = nb.isValid && originalResult === 'valid';
        const flagsBase = [...(nb.flags || []), 'neverbounce_primary'];
        const flags = [...flagsBase];

        if (originalResult === 'valid' || originalResult === 'catchall') {
          mappedResult = 'valid';
          isValidMapped = true;
          deliverable = true;
          if (originalResult === 'catchall') {
            flags.push('neverbounce_original_catchall', 'catchall_mapped_to_valid');
          }
        }

        const bounceRisk: 'low' | 'medium' | 'high' = 'low';
        const confidence = 85;
        const confidenceLevel: 'low' | 'medium' | 'high' | 'very_high' = 'very_high';

        console.info(`[VALIDATE_EMAIL] ✅ NeverBounce primary success: ${originalResult} -> ${mappedResult}`);

        return NextResponse.json({
          success: true,
          data: {
            email: nb.email,
            isValid: isValidMapped,
            deliverable,
            result: mappedResult,
            flags,
            suggested_correction: nb.suggested_correction ?? null,
            execution_time: nb.execution_time,
            message: `NeverBounce: ${nb.message || originalResult}${originalResult === 'catchall' ? ' (mapped_to_valid)' : ''}`,
            timestamp: new Date().toISOString(),
            bounceRisk,
            reputationFlags: ['neverbounce_validation'],
            riskFactors: ['neverbounce_primary'],
            confidence,
            confidenceLevel,
            reasoning: ['Used NeverBounce as primary provider', 'Returned NeverBounce result'],
            aggressiveMode
          },
          temporal: temporalInfo,
          provider: 'neverbounce',
          fallback: false
        }, { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (nbErr: any) {
        console.error(`[VALIDATE_EMAIL] ❌ NeverBounce primary error`, nbErr?.message || nbErr);
        return null;
      }
    };

    // Helper: fallback via NeverBounce integration if we've exceeded timeout
    const maybeTimeoutFallback = async (): Promise<NextResponse | null> => {
      if (Date.now() <= deadline) return null;
      console.log(`[VALIDATE_EMAIL] ⏱️ Exceeded ${TIMEOUT_MS}ms, falling back to NeverBounce (SDK)`);

      try {
        const nb = await validateWithNeverBounce(email);
        const originalResult = (nb.result || (nb.isValid ? 'valid' : 'invalid')) as 'valid' | 'invalid' | 'disposable' | 'catchall' | 'unknown';
        let mappedResult: 'valid' | 'invalid' | 'disposable' | 'catchall' | 'unknown' = originalResult;
        let isValidMapped = nb.isValid;
        let deliverable = nb.isValid && originalResult === 'valid';
        const flagsBase = [...(nb.flags || []), 'fallback_neverbounce'];
        const flags = [...flagsBase];

        if (originalResult === 'valid' || originalResult === 'catchall') {
          mappedResult = 'valid';
          isValidMapped = true;
          deliverable = true;
          if (originalResult === 'catchall') {
            flags.push('neverbounce_original_catchall', 'catchall_mapped_to_valid');
          }
        }

        const bounceRisk: 'low' | 'medium' | 'high' = 'low';
        const confidence = 85;
        const confidenceLevel: 'low' | 'medium' | 'high' | 'very_high' = 'very_high';

        return NextResponse.json({
          success: true,
          data: {
            email: nb.email,
            isValid: isValidMapped,
            deliverable,
            result: mappedResult,
            flags,
            suggested_correction: nb.suggested_correction ?? null,
            execution_time: nb.execution_time,
            message: `NeverBounce: ${nb.message || originalResult}${originalResult === 'catchall' ? ' (mapped_to_valid)' : ''}`,
            timestamp: new Date().toISOString(),
            bounceRisk,
            reputationFlags: ['neverbounce_validation'],
            riskFactors: ['neverbounce_fallback'],
            confidence,
            confidenceLevel,
            reasoning: ['Primary validation exceeded timeout', 'Returned NeverBounce result'] ,
            aggressiveMode
          },
          temporal: temporalInfo,
          provider: 'neverbounce',
          fallback: true
        }, { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (nbErr: any) {
        console.error(`[VALIDATE_EMAIL] ❌ NeverBounce SDK fallback failed`, nbErr);

        // Try final fallback route if provided via header or env var
        const finalFallbackPath = request.headers.get('x-email-validation-fallback-path') || process.env.EMAIL_VALIDATION_FINAL_FALLBACK_PATH;
        if (finalFallbackPath) {
          try {
            const xfp = request.headers.get('x-forwarded-proto');
            const xfHost = request.headers.get('x-forwarded-host');
            const host = xfHost || request.headers.get('host') || process.env.NEXT_PUBLIC_VERCEL_URL || 'localhost:3000';
            const proto = xfp || (process.env.VERCEL ? 'https' : 'http');
            const origin = process.env.NEXT_PUBLIC_APP_URL || `${proto}://${host}`;
            const finalUrl = finalFallbackPath.startsWith('http') ? finalFallbackPath : `${origin}${finalFallbackPath.startsWith('/') ? '' : '/'}${finalFallbackPath}`;

            const finalRes = await fetch(finalUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email })
            });

            const finalJson = await finalRes.json().catch(() => null);
            if (finalRes.ok && finalJson) {
              return NextResponse.json(finalJson, { status: finalRes.status, headers: { 'Content-Type': 'application/json' } });
            } else {
              console.error(`[VALIDATE_EMAIL] ❌ Final fallback route failed`, { status: finalRes.status, finalJson });
            }
          } catch (finalErr: any) {
            console.error(`[VALIDATE_EMAIL] ❌ Error calling final fallback route`, finalErr);
          }
        }

        return NextResponse.json({
          success: false,
          error: {
            code: 'TIMEOUT_FALLBACK_FAILED',
            message: 'Primary validation timed out and fallbacks failed',
            details: 'Exceeded timeout and failed to fetch fallback validations'
          },
          temporal: temporalInfo
        }, { status: 504, headers: { 'Content-Type': 'application/json' } });
      }
    };
    
    // Validate that email is provided
    if (!email) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'EMAIL_REQUIRED',
          message: 'Email is required',
          details: 'Please provide an email address to validate'
        },
        temporal: temporalInfo
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
        },
        temporal: temporalInfo
      }, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Prefer NeverBounce as the primary provider
    {
      console.info(`[VALIDATE_EMAIL] ⬆️ Preferring NeverBounce as primary provider`);
      const nbResponse = await tryNeverBouncePrimary();
      if (nbResponse) return nbResponse;
      console.info(`[VALIDATE_EMAIL] ⏭️ NeverBounce did not produce a usable response, continuing with DNS/SMTP flow`);
    }
    
    // Start Temporal workflow asynchronously before heavy validation
    try {
      const workflowService = WorkflowService.getInstance();
      const workflowOptions = {
        priority: 'medium' as const,
        async: true,
        retryAttempts: 0,
        taskQueue: process.env.EMAIL_VALIDATION_TASK_QUEUE || process.env.WORKFLOW_TASK_QUEUE || 'email-validation-queue',
        workflowId: `validate-email-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      };
      const workflowStart = await workflowService.executeWorkflow(
        'validateEmailWorkflow',
        { email, aggressiveMode },
        workflowOptions
      );
      temporalInfo = {
        started: !!workflowStart.success,
        workflowId: workflowStart.workflowId,
        executionId: workflowStart.executionId,
        runId: workflowStart.runId,
        status: workflowStart.status || 'running'
      };
      console.log(`[VALIDATE_EMAIL] 🧭 Temporal workflow started:`, temporalInfo);
    } catch (temporalErr: any) {
      console.error(`[VALIDATE_EMAIL] ⚠️ Failed to start Temporal workflow:`, temporalErr);
      temporalInfo = { started: false, error: temporalErr?.message || 'Unknown Temporal error' };
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
        },
        temporal: temporalInfo
      }, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    console.log(`[VALIDATE_EMAIL] ✅ Domain exists: ${domain} (IPv4: ${domainCheck.hasARecord})`);
    
    // If we've already exceeded the timeout, use NeverBounce
    {
      const timeoutResponse = await maybeTimeoutFallback();
      if (timeoutResponse) return timeoutResponse;
    }

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
        },
        temporal: temporalInfo
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
      
      // Check if domain is likely a non-email domain before expensive fallback validation
      let fallbackResult = null;
      if (error.code === 'NO_MX_RECORDS' || error.code === 'DNS_TIMEOUT' || error.code === 'DNS_SERVER_FAILURE') {
        // Quick check for obviously non-email domains
        const nonEmailCheck = isLikelyNonEmailDomain(domain);
        
        if (nonEmailCheck.isNonEmail) {
          console.log(`[VALIDATE_EMAIL] 🚫 Skipping fallback - likely non-email domain: ${nonEmailCheck.reason} (confidence: ${nonEmailCheck.confidence}%)`);
          // Don't perform expensive fallback validation for obvious non-email domains
        } else {
          console.log(`[VALIDATE_EMAIL] 🔄 Attempting fallback validation for ${domain} (error: ${error.code})`);
          try {
            fallbackResult = await attemptFallbackValidation(domain);
            console.log(`[VALIDATE_EMAIL] 📋 Fallback result:`, {
              canReceiveEmail: fallbackResult.canReceiveEmail,
              method: fallbackResult.fallbackMethod,
              confidence: fallbackResult.confidence,
              flags: fallbackResult.flags,
              message: fallbackResult.message
            });
          } catch (fallbackError: any) {
            console.error(`[VALIDATE_EMAIL] ❌ Fallback validation failed:`, fallbackError.message || fallbackError);
          }
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
          const nonEmailCheck = isLikelyNonEmailDomain(domain);
          
          if (fallbackResult?.canReceiveEmail) {
            // Fallback validation found evidence of email capability
            result = 'risky';
            isValid = true;
            deliverable = false;
            flags = ['no_mx_record', ...fallbackResult.flags];
            message = `No MX records but ${fallbackResult.message}`;
            bounceRisk = 'high';
            reputationFlags = ['no_mx_but_mail_capable'];
            confidence = Math.max(fallbackResult.confidence, 40); // Minimum confidence for positive fallback
            confidenceLevel = confidence >= 70 ? 'high' : confidence >= 50 ? 'medium' : 'low';
            reasoning = [
              'No MX records found (-40)',
              `Fallback validation: ${fallbackResult.fallbackMethod} (+${fallbackResult.confidence})`
            ];
          } else if (nonEmailCheck.isNonEmail) {
            // Domain pattern suggests it's not meant for email
            result = 'invalid';
            flags = ['no_mx_record', 'likely_non_email_domain'];
            message = `Domain exists but appears to be a non-email domain: ${nonEmailCheck.reason}`;
            bounceRisk = 'high';
            reputationFlags = ['non_email_domain'];
            confidence = Math.max(90, nonEmailCheck.confidence);
            confidenceLevel = 'very_high';
            reasoning = [
              'No MX records found (-40)',
              `Non-email domain pattern detected (+${nonEmailCheck.confidence})`
            ];
          } else {
            // No MX records and no fallback evidence - likely invalid for email
            result = 'invalid';
            flags = ['no_mx_record'];
            message = 'Domain exists but has no mail servers configured and no fallback methods indicate email capability';
            bounceRisk = 'high';
            reputationFlags = ['no_mail_service'];
            confidence = 85; // High confidence that it can't receive email
            confidenceLevel = 'very_high';
            reasoning = [
              'No MX records found (-40)',
              'No fallback validation methods succeeded (-45)',
              'Domain exists but shows no email capability'
            ];
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
        },
        temporal: temporalInfo
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
        },
        temporal: temporalInfo
      }, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Try SMTP validation with MX records (try multiple if first fails with timeout)
    console.log(`[VALIDATE_EMAIL] 🔌 Attempting SMTP validation with ${mxRecords.length} MX record(s)`);
    
    // Timeout check before starting SMTP attempts
    {
      const timeoutResponse = await maybeTimeoutFallback();
      if (timeoutResponse) return timeoutResponse;
    }

    // Check if we're running in Vercel (serverless environment)
    const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV;
    const maxMXAttempts = isVercel ? 2 : 3; // Reduce attempts in Vercel for faster response
    
    let smtpResult = null;
    let lastError = null;
    
    for (let i = 0; i < Math.min(mxRecords.length, maxMXAttempts); i++) { // Try fewer MX records in Vercel
      const mxRecord = mxRecords[i];
      console.log(`[VALIDATE_EMAIL] 🔌 Trying MX record ${i + 1}/${mxRecords.length}: ${mxRecord.exchange} (priority: ${mxRecord.priority})`);
      // Timeout check per attempt
      {
        const timeoutResponse = await maybeTimeoutFallback();
        if (timeoutResponse) return timeoutResponse;
      }
      
      try {
        smtpResult = await performSMTPValidation(email, mxRecord, aggressiveMode);
        
        // If we get a definitive result (valid/invalid), use it
        if (smtpResult.result === 'valid' || smtpResult.result === 'invalid' || smtpResult.result === 'catchall') {
          console.log(`[VALIDATE_EMAIL] ✅ Got definitive result from ${mxRecord.exchange}: ${smtpResult.result}`);
          break;
        }
        
        // If we get 'unknown' but it's not a timeout, check if it's an IP block
        if (smtpResult.result === 'unknown' && !smtpResult.flags.includes('smtp_timeout')) {
          // If this is an IP block, we should try fallback validation
          if (smtpResult.flags.includes('ip_blocked') || smtpResult.flags.includes('validation_blocked')) {
            console.log(`[VALIDATE_EMAIL] 🚫 IP blocked by ${mxRecord.exchange}, will attempt fallback validation`);
            // Continue to try other MX records or fallback validation
            if (i < Math.min(mxRecords.length, 3) - 1) {
              lastError = smtpResult;
              continue;
            }
          } else {
            console.log(`[VALIDATE_EMAIL] ⚠️ Got inconclusive result from ${mxRecord.exchange}: ${smtpResult.result}`);
            break;
          }
        }
        
        // If it's a timeout or risky result, try next MX record if available
        if (i < Math.min(mxRecords.length, maxMXAttempts) - 1) {
          console.log(`[VALIDATE_EMAIL] ⏱️ Timeout/risky result from ${mxRecord.exchange}, trying next MX record...`);
          lastError = smtpResult;
          continue;
        }
        
      } catch (smtpError: unknown) {
        console.log(`[VALIDATE_EMAIL] ❌ Error with MX record ${mxRecord.exchange}:`, smtpError);
        lastError = smtpError;
        
        // If this is the last MX record, we'll use the error
        if (i === Math.min(mxRecords.length, maxMXAttempts) - 1) {
          // Create a fallback result for the error
          const errorMessage = smtpError instanceof Error ? smtpError.message : 'Unknown error';
          smtpResult = {
            isValid: false,
            deliverable: false,
            result: 'unknown' as const,
            flags: ['smtp_error'],
            message: `All MX servers failed: ${errorMessage}`,
            confidence: 20,
            confidenceLevel: 'low' as const,
            reasoning: [`SMTP validation failed for all ${i + 1} MX servers`]
          };
        }
      }
    }
    
    // If we still don't have a result, use the last error
    if (!smtpResult) {
      smtpResult = {
        isValid: false,
        deliverable: false,
        result: 'unknown' as const,
        flags: ['all_mx_failed'],
        message: 'All MX servers failed validation',
        confidence: 15,
        confidenceLevel: 'low' as const,
        reasoning: ['All available MX servers failed to respond']
      };
    }
    
    // Final timeout check before fallback analysis and response assembly
    {
      const timeoutResponse = await maybeTimeoutFallback();
      if (timeoutResponse) return timeoutResponse;
    }

    // If we got IP blocks from all MX servers, or if we're in Vercel and got connection issues, try fallback validation
    const allBlocked = smtpResult.flags.includes('ip_blocked') || 
                      smtpResult.flags.includes('validation_blocked') ||
                      (lastError && typeof lastError === 'object' && 'flags' in lastError && 
                       Array.isArray((lastError as any).flags) &&
                       ((lastError as any).flags.includes('ip_blocked') || (lastError as any).flags.includes('validation_blocked')));
    
    const hasConnectionIssues = smtpResult.flags.includes('connection_failed') || 
                               smtpResult.flags.includes('smtp_timeout') ||
                               smtpResult.flags.includes('all_mx_failed');
    
    const shouldTryFallback = allBlocked || (isVercel && hasConnectionIssues && smtpResult.result === 'unknown');
    
    if (shouldTryFallback) {
      const fallbackReason = allBlocked ? 'IP blocked by servers' : 'Connection issues in serverless environment';
      console.log(`[VALIDATE_EMAIL] 🔄 ${fallbackReason}, attempting fallback validation for ${domain}`);
      
      try {
        // First try basic validation (similar to other providers)
        console.log(`[VALIDATE_EMAIL] 🔍 Performing basic email validation check`);
        const basicValidation = await performBasicEmailValidation(domain);
        
        console.log(`[VALIDATE_EMAIL] Basic validation results:`, {
          has_dns: basicValidation.has_dns,
          has_dns_mx: basicValidation.has_dns_mx,
          smtp_connectable: basicValidation.smtp_connectable,
          details: basicValidation.details
        });
        
        // If basic validation shows email capability, use it
        if (basicValidation.has_dns && basicValidation.has_dns_mx) {
          const confidence = basicValidation.smtp_connectable ? 70 : 50;
          const flags = ['basic_validation'];
          
          if (basicValidation.has_dns) flags.push('has_dns');
          if (basicValidation.has_dns_mx) flags.push('has_dns_mx');
          if (basicValidation.smtp_connectable) flags.push('smtp_connectable');
          
          smtpResult = {
            isValid: true,
            deliverable: basicValidation.smtp_connectable, // Deliverable if SMTP is connectable
            result: basicValidation.smtp_connectable ? 'valid' : 'risky' as const,
            flags: [...smtpResult.flags, ...flags],
            message: `Basic validation: DNS=${basicValidation.has_dns}, MX=${basicValidation.has_dns_mx}, SMTP=${basicValidation.smtp_connectable}`,
            confidence,
            confidenceLevel: confidence >= 70 ? 'high' : confidence >= 50 ? 'medium' : 'low' as const,
            reasoning: [
              `DNS records found (+${basicValidation.has_dns ? 20 : 0})`,
              `MX records found (+${basicValidation.has_dns_mx ? 30 : 0})`,
              `SMTP connectable (+${basicValidation.smtp_connectable ? 20 : 0})`
            ]
          };
          
          console.log(`[VALIDATE_EMAIL] ✅ Basic validation successful with confidence ${confidence}%`);
        } else {
          // Try advanced fallback validation
          const fallbackResult = await attemptFallbackValidation(domain);
          
          if (fallbackResult.canReceiveEmail) {
            // Fallback validation suggests the domain can receive email
            console.log(`[VALIDATE_EMAIL] ✅ Advanced fallback validation successful: ${fallbackResult.message}`);
            
            smtpResult = {
              isValid: true,
              deliverable: false, // Still risky due to validation limitations
              result: 'risky' as const,
              flags: [...smtpResult.flags, 'fallback_validation', ...fallbackResult.flags],
              message: `SMTP validation blocked but ${fallbackResult.message}`,
              confidence: Math.max(fallbackResult.confidence - 20, 30), // Reduce confidence due to IP block
              confidenceLevel: fallbackResult.confidence >= 70 ? 'medium' : 'low' as const,
              reasoning: [
                'SMTP validation blocked by IP reputation (-40)',
                `Fallback validation: ${fallbackResult.fallbackMethod} (+${fallbackResult.confidence})`
              ]
            };
          } else {
            console.log(`[VALIDATE_EMAIL] ❌ All fallback validations failed`);
            // Keep original result but add fallback info
            smtpResult.flags.push('all_fallbacks_failed');
            smtpResult.reasoning = [
              ...(smtpResult.reasoning || []),
              'Basic and advanced fallback validation failed (-10)'
            ];
          }
        }
      } catch (fallbackError: any) {
        console.error(`[VALIDATE_EMAIL] ❌ Fallback validation error:`, fallbackError.message || fallbackError);
        smtpResult.flags.push('fallback_error');
      }
    }
    
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
      },
      temporal: temporalInfo
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
      },
      temporal: null
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