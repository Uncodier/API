import { promises as dns } from 'dns';
import * as net from 'net';
import * as tls from 'tls';

export interface MXRecord {
  exchange: string;
  priority: number;
}

export interface SMTPResponse {
  code: number;
  message: string;
}

export interface EmailValidationResult {
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

/**
 * Validates email format using regex
 */
export function isValidEmailFormat(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Extracts domain from email address
 */
export function extractDomain(email: string): string {
  return email.split('@')[1];
}

/**
 * Checks if domain is a known disposable email provider
 */
export function isDisposableEmail(domain: string): boolean {
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
 * Quick check to determine if a domain is likely a non-email domain
 */
export function isLikelyNonEmailDomain(domain: string): {
  isNonEmail: boolean;
  reason: string;
  confidence: number;
} {
  const lowerDomain = domain.toLowerCase();
  
  // Check for common non-email domain patterns
  const nonEmailPatterns = [
    { pattern: /^\d+\.\w+$/, reason: 'Numeric domain (likely parking/placeholder)', confidence: 85 },
    { pattern: /^[a-z0-9]+\.(tk|ml|ga|cf)$/, reason: 'Free domain service (rarely used for email)', confidence: 80 },
    { pattern: /^www\./, reason: 'WWW subdomain (not typically used for email)', confidence: 70 },
    { pattern: /\.(example|test|localhost|invalid)$/, reason: 'Reserved/test domain', confidence: 95 },
    { pattern: /^[0-9]{4,}\.(com|net|org)$/, reason: 'Numeric domain pattern (likely placeholder)', confidence: 80 }
  ];
  
  for (const { pattern, reason, confidence } of nonEmailPatterns) {
    if (pattern.test(lowerDomain)) {
      return { isNonEmail: true, reason, confidence };
    }
  }
  
  // Check for very short domains (often placeholders)
  if (lowerDomain.length <= 6 && /^[0-9]+\.(com|net|org)$/.test(lowerDomain)) {
    return { 
      isNonEmail: true, 
      reason: 'Very short numeric domain (likely placeholder)', 
      confidence: 75 
    };
  }
  
  return { isNonEmail: false, reason: '', confidence: 0 };
}

/**
 * Creates a timeout wrapper for DNS operations
 */
export function withDNSTimeout<T>(operation: Promise<T>, timeout: number = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`DNS operation timeout after ${timeout}ms`));
    }, timeout);

    operation
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

/**
 * Creates a socket connection with controlled timeout (no exceptions)
 */
export function createSocketWithTimeout(host: string, port: number, timeout: number = 4000): Promise<{
  success: boolean;
  socket?: net.Socket;
  error?: string;
  errorCode?: string;
}> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isResolved = false;
    
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve({
          success: false,
          error: `Connection timeout to ${host}:${port} after ${timeout}ms`,
          errorCode: 'TIMEOUT'
        });
      }
    }, timeout);
    
    socket.connect(port, host, () => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        resolve({
          success: true,
          socket
        });
      }
    });
    
    socket.on('error', (error: any) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        resolve({
          success: false,
          error: error.message || 'Connection error',
          errorCode: error.code || 'CONNECTION_ERROR'
        });
      }
    });
  });
}

/**
 * Reads SMTP response from socket with controlled timeout (no exceptions)
 */
export function readSMTPResponse(socket: net.Socket): Promise<{
  success: boolean;
  response?: SMTPResponse;
  error?: string;
  errorCode?: string;
}> {
  return new Promise((resolve) => {
    let isResolved = false;
    
    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        resolve({
          success: false,
          error: 'SMTP response timeout after 2000ms',
          errorCode: 'RESPONSE_TIMEOUT'
        });
      }
    }, 2000);
    
    socket.once('data', (data) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeout);
        try {
          const response = data.toString().trim();
          const code = parseInt(response.substring(0, 3));
          const message = response.substring(4);
          resolve({
            success: true,
            response: { code, message }
          });
        } catch (error: any) {
          resolve({
            success: false,
            error: 'Failed to parse SMTP response',
            errorCode: 'PARSE_ERROR'
          });
        }
      }
    });
    
    socket.once('error', (error: any) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeout);
        resolve({
          success: false,
          error: error.message || 'Socket error',
          errorCode: error.code || 'SOCKET_ERROR'
        });
      }
    });
  });
}

/**
 * Sends SMTP command and waits for response (controlled, no exceptions)
 */
export async function sendSMTPCommand(socket: net.Socket, command: string): Promise<{
  success: boolean;
  response?: SMTPResponse;
  error?: string;
  errorCode?: string;
}> {
  try {
    socket.write(command + '\r\n');
    return await readSMTPResponse(socket);
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to send SMTP command',
      errorCode: 'SEND_ERROR'
    };
  }
}
