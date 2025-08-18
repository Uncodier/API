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
  isValid: boolean;
  result: 'valid' | 'invalid' | 'unknown' | 'disposable' | 'catchall';
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
 * Performs MX record lookup for a domain
 */
async function getMXRecords(domain: string): Promise<MXRecord[]> {
  try {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority);
  } catch (error) {
    console.error(`[VALIDATE_EMAIL] Error resolving MX records for ${domain}:`, error);
    throw new Error(`Failed to resolve MX records for domain: ${domain}`);
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
 * Performs SMTP validation for an email address
 */
async function performSMTPValidation(email: string, mxRecord: MXRecord): Promise<{
  isValid: boolean;
  result: 'valid' | 'invalid' | 'unknown' | 'disposable' | 'catchall';
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
    let result: 'valid' | 'invalid' | 'unknown' | 'disposable' | 'catchall' = 'unknown';
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
    
    // Check for catchall indicators
    if (rcptToResponse.message.toLowerCase().includes('catch') || 
        rcptToResponse.message.toLowerCase().includes('accept all')) {
      result = 'catchall';
      flags.push('catchall_domain');
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
 * Validates an email address using SMTP validation
 * 
 * Body:
 * {
 *   "email": "email@example.com"
 * }
 * 
 * Response format matches neverbounce integration:
 * {
 *   "success": true,
 *   "data": {
 *     "email": "email@example.com",
 *     "isValid": true,
 *     "result": "valid",
 *     "flags": [],
 *     "suggested_correction": null,
 *     "execution_time": 123,
 *     "message": "Email is valid",
 *     "timestamp": "2024-01-01T00:00:00.000Z"
 *   }
 * }
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    console.log(`[VALIDATE_EMAIL] 🚀 Starting email validation process`);
    
    // Parse request body
    const body = await request.json();
    const { email } = body;
    
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
    
    console.log(`[VALIDATE_EMAIL] 📧 Validating email: ${email}`);
    
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
          timestamp: new Date().toISOString()
        }
      }, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const domain = extractDomain(email);
    console.log(`[VALIDATE_EMAIL] 🌐 Domain extracted: ${domain}`);
    
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
          timestamp: new Date().toISOString()
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
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`[VALIDATE_EMAIL] ❌ Failed to get MX records:`, error);
      
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
          timestamp: new Date().toISOString()
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
          timestamp: new Date().toISOString()
        }
      }, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Try SMTP validation with the primary MX record
    console.log(`[VALIDATE_EMAIL] 🔌 Attempting SMTP validation with primary MX: ${mxRecords[0].exchange}`);
    
    const smtpResult = await performSMTPValidation(email, mxRecords[0]);
    const executionTime = Date.now() - startTime;
    
    console.log(`[VALIDATE_EMAIL] ✅ SMTP validation completed:`, {
      isValid: smtpResult.isValid,
      result: smtpResult.result,
      flags: smtpResult.flags,
      executionTime
    });
    
    const response = {
      success: true,
      data: {
        email,
        isValid: smtpResult.isValid,
        result: smtpResult.result,
        flags: smtpResult.flags,
        suggested_correction: null,
        execution_time: executionTime,
        message: smtpResult.message,
        timestamp: new Date().toISOString()
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
      service: 'SMTP Email Validation',
      version: '1.0.0',
      description: 'Validate email addresses using SMTP protocol and MX record lookup',
      endpoints: {
        validate: {
          method: 'POST',
          path: '/api/agents/tools/validateEmail',
          description: 'Validate a single email address using SMTP',
          body: {
            email: 'string (required) - Email address to validate'
          },
          response: {
            success: 'boolean - Operation success status',
            data: {
              email: 'string - The validated email',
              isValid: 'boolean - Whether the email is valid',
              result: 'string - Validation result (valid, invalid, disposable, catchall, unknown)',
              flags: 'array - Additional validation flags',
              suggested_correction: 'string|null - Suggested correction if available',
              execution_time: 'number - Time taken to validate in milliseconds',
              message: 'string - Human readable message',
              timestamp: 'string - ISO timestamp of validation'
            }
          }
        }
      },
      features: [
        'MX record lookup',
        'SMTP connection testing',
        'TLS/STARTTLS support',
        'Disposable email detection',
        'Catchall domain detection',
        'Anti-spam policy detection'
      ],
      timestamp: new Date().toISOString()
    }
  }, {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
